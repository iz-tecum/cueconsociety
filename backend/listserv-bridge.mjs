import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, lstat, stat, realpath, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const STATES = new Set(['subscribed', 'unsubscribed', 'cleaned', 'archived', 'pending']);
const SUPPRESSED = new Set(['unsubscribed', 'cleaned', 'archived']);
const RANK = { unknown: 0, pending: 1, subscribed: 2, archived: 3, unsubscribed: 4, cleaned: 5 };
const MAX_ROWS = 100000;
const SOURCES = [
  'https://www.cuit.columbia.edu/listserv',
  'https://lsoft.com/news/techtipLSV-issue5-2019.asp'
];

export function emailAddress(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email)) return null;
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some(part => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) return null;
  return email;
}

export function parseCSV(input) {
  const text = input.replace(/^\uFEFF/, ''), rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (row.some(value => value.length)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('Invalid CSV quoting.');
    else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV field.');
  row.push(field); if (row.some(value => value.length)) rows.push(row);
  if (!rows.length) throw new Error('The CSV needs a header row.');
  const headers = rows.shift().map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique and nonempty.');
  if (rows.length > MAX_ROWS) throw new Error('Too many input rows.');
  return { headers, rows: rows.map(values => {
    if (values.length !== headers.length) throw new Error('CSV row length does not match its headers.');
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  }) };
}

export function audienceRows(input, format) {
  if (format === 'csv') {
    const parsed = parseCSV(input);
    const normalized = parsed.headers.map(header => [header.toLowerCase().replaceAll(' ', '').replaceAll('_', ''), header]);
    const emails = normalized.filter(([name]) => ['email', 'emailaddress'].includes(name));
    const statuses = normalized.filter(([name]) => ['status', 'subscriptionstatus'].includes(name));
    if (new Set(normalized.map(([name]) => name)).size !== normalized.length || emails.length !== 1 || statuses.length !== 1) throw new Error('Audience CSV needs unambiguous email and status columns.');
    const email = emails[0][1], status = statuses[0][1];
    return parsed.rows.map(row => ({ email: row[email], status: row[status] }));
  }
  const data = JSON.parse(input);
  const records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : data?.subscribers && typeof data.subscribers === 'object' && !Array.isArray(data.subscribers) ? Object.values(data.subscribers) : null;
  if (!Array.isArray(records) || records.length > MAX_ROWS) throw new Error('Use an audience array, records export, or legacy subscribers state.');
  return records;
}

export function normalizeAudience(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('Invalid audience input.');
  const records = new Map(), invalid = [], duplicates = [];
  rows.forEach((row, index) => {
    const email = emailAddress(row?.email);
    if (!email) { invalid.push({ row: index + 1, reason: 'invalid-or-unsupported-listserv-address' }); return; }
    const raw = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    const status = STATES.has(raw) ? raw : 'unknown';
    const previous = records.get(email);
    if (previous) {
      previous.duplicate = true;
      previous.status = RANK[status] > RANK[previous.status] ? status : previous.status;
      previous.observedStatuses = [...new Set([...previous.observedStatuses, status])];
      duplicates.push({ row: index + 1, email, status });
    } else records.set(email, { email, status, duplicate: false, observedStatuses: [status] });
  });
  return { records: [...records.values()].sort((a, b) => a.email.localeCompare(b.email)), invalid, duplicates, inputRows: rows.length };
}

export function listservRoster(input, { format, emailColumn } = {}) {
  let values;
  if (format === 'csv') {
    if (typeof emailColumn !== 'string' || !emailColumn.trim()) throw new Error('Specify the exact Listserv email-column header.');
    const parsed = parseCSV(input);
    if (!parsed.headers.includes(emailColumn)) throw new Error('The selected Listserv email column does not exist.');
    values = parsed.rows.map(row => row[emailColumn]);
  } else if (format === 'email-lines') {
    if (emailColumn) throw new Error('Use email-column only with a CSV roster.');
    values = input.replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } else throw new Error('Use an explicitly selected csv or email-lines Listserv format.');
  if (values.length > MAX_ROWS) throw new Error('Too many roster rows.');
  const emails = new Set(), invalid = [], duplicates = [];
  values.forEach((value, index) => {
    const email = emailAddress(value);
    if (!email) invalid.push({ row: index + 1, reason: 'invalid-or-unsupported-listserv-address' });
    else if (emails.has(email)) duplicates.push({ row: index + 1, email });
    else emails.add(email);
  });
  return { emails: [...emails].sort(), invalid, duplicates, inputRows: values.length, format, emailColumn: emailColumn || null };
}

export function reconcile(audience, roster, { mode } = {}) {
  if (!['first-import', 'reconcile'].includes(mode)) throw new Error('Choose first-import or reconcile explicitly.');
  if (mode === 'reconcile' && !roster) throw new Error('Reconciliation requires a current Listserv roster.');
  if (mode === 'first-import' && roster?.emails.length) throw new Error('First-import is for a new empty list. Use reconcile for an existing roster.');
  const remote = new Set(roster?.emails || []), local = new Map(audience.records.map(row => [row.email, row]));
  const suppressionExclusions = audience.records.filter(row => SUPPRESSED.has(row.status)).map(({ email, status }) => ({ email, status }));
  const held = audience.records.filter(row => !SUPPRESSED.has(row.status) && (row.duplicate || row.status !== 'subscribed'))
    .map(row => ({ email: row.email, status: row.status, reason: row.duplicate ? 'duplicate-local-record-review' : 'not-confirmed-subscribed' }));
  const eligible = audience.records.filter(row => row.status === 'subscribed' && !row.duplicate);
  const reportOnly = Boolean(roster?.invalid.length);
  const initialCandidates = mode === 'first-import' && !reportOnly ? eligible.map(row => row.email) : [];
  const removals = mode === 'reconcile' && !reportOnly ? suppressionExclusions.filter(row => remote.has(row.email)) : [];
  const missing = mode === 'reconcile' ? eligible.filter(row => !remote.has(row.email)).map(row => ({ email: row.email, reason: 'absent-from-authoritative-roster-review-consent-do-not-readd' })) : [];
  const remoteOnly = [...remote].filter(email => !local.has(email));
  const matched = eligible.filter(row => remote.has(row.email)).map(row => row.email);
  const remoteReview = held.filter(row => remote.has(row.email));
  return {
    schema: 'ces-listserv-reconciliation-v1', mode, reportOnly,
    policy: 'Listserv is the authoritative delivery roster after migration. Missing addresses are never automatically re-added or treated as newly consenting.',
    counts: { localRows: audience.inputRows, localUnique: audience.records.length, localInvalid: audience.invalid.length, localDuplicateRows: audience.duplicates.length,
      currentListservUnique: roster ? remote.size : null, currentListservInvalid: roster?.invalid.length ?? null, currentListservDuplicateRows: roster?.duplicates.length ?? null,
      initialImportCandidates: initialCandidates.length, removals: removals.length, localSuppressionExclusions: suppressionExclusions.length,
      heldForReview: held.length, localSubscribedMissingFromListserv: missing.length, listservOnly: remoteOnly.length, subscribedOnBoth: matched.length },
    initialImportCandidates: initialCandidates, removeLocalSuppressedPresentOnListserv: removals,
    suppressionExclusions, localSubscribedMissingFromListserv: missing, listservOnly: remoteOnly, subscribedOnBoth: matched,
    heldForReview: held, reviewLocalNonSubscribedPresentOnListserv: remoteReview,
    invalidLocalRows: audience.invalid, duplicateLocalRows: audience.duplicates,
    invalidListservRows: roster?.invalid || [], duplicateListservRows: roster?.duplicates || [],
    actionFormat: 'Plain UTF-8 TXT, one email address per line, no header or command text. Choose the matching add/remove Bulk Operations action manually.',
    documentation: SOURCES, networkRequests: 0, emailsSent: 0, sourceDataChanged: false
  };
}

async function exists(filename) { try { await access(filename, constants.F_OK); return true; } catch { return false; } }
async function outsideGit(filename) {
  let current = path.dirname(filename);
  while (true) {
    if (await exists(path.join(current, '.git'))) throw new Error('Keep private inputs and packets outside Git checkouts.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function privateFile(filename, maximum = 32 * 1024 * 1024) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Use absolute private input paths.');
  const initial = await lstat(filename);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('Inputs must be regular private files.');
  const canonical = await realpath(filename), info = await stat(canonical), parent = await stat(path.dirname(canonical));
  if (info.size > maximum || (info.mode & 0o077) || (parent.mode & 0o077) || (process.getuid && (info.uid !== process.getuid() || parent.uid !== process.getuid()))) throw new Error('Use owner-only inputs (600) inside an owner-only directory (700).');
  await outsideGit(canonical); return canonical;
}
async function readAudience(flags) {
  if (flags['--database']) {
    const filename = await privateFile(flags['--database'], 512 * 1024 * 1024);
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      database.exec('PRAGMA query_only=ON');
      const rows = database.prepare('SELECT email,status FROM contacts ORDER BY email').all();
      return { rows, source: { kind: 'sqlite-read-only', filename, rows: rows.length, selectedRowsSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') } };
    } finally { database.close(); }
  }
  const filename = await privateFile(flags['--audience']);
  const extension = path.extname(filename).toLowerCase();
  if (!['.json', '.csv'].includes(extension)) throw new Error('Audience export must be JSON or CSV.');
  const bytes = await readFile(filename), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { rows: audienceRows(text, extension.slice(1)), source: { kind: extension.slice(1), filename, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
function csvCell(value) { let text = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
function csv(rows, columns) { return [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n') + '\r\n'; }

function instructions(report) {
  return `CES LISTSERV HANDOFF — ${report.mode.toUpperCase()}\n\nThis is a review packet. No network request, Listserv change, or email was made.\n\n${report.reportOnly ? 'REPORT ONLY: the current roster contains invalid rows. Correct or re-export it before generating action files.\n' : report.mode === 'first-import' ? 'Use this mode only for a new empty list. Review 01_initial_subscribed_candidates.txt, then choose Add imported addresses in Listserv Bulk Operations if the import is approved. Do not use a replace-all option.\n' : 'Listserv is the current delivery roster. Review 02_remove_local_suppressed_present_on_listserv.txt, if present, using the remove-imported-addresses operation. There is deliberately no add file. Missing local subscribers may have unsubscribed or bounced on Listserv; review consent before any re-addition.\n'}\nThe TXT action format is one email per line with no header or commands. Suppression_exclusions.csv is a reference only; it is not an add/import file. Local duplicate, unknown, and pending records are held for review. See reconciliation.json for every discrepancy and input fingerprint.\n\nTake a fresh roster export before acting. For CSV input, choose the actual email column explicitly; this tool does not guess Listserv export headers. A matching count does not prove synchronization.\n\nKeep this packet private. No source contact statuses, drafts, or database records were changed. List creation, university approval, owner permissions, and any Listserv notifications remain separate actions.\n\nOfficial format references\n${SOURCES.join('\n')}\n`;
}

export async function run(argv) {
  if (argv.length % 2) throw new Error('Supply named options with values.');
  const allowed = new Set(['--mode', '--audience', '--database', '--listserv', '--listserv-format', '--listserv-email-column', '--output']);
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(flags, argv[i]) || !argv[i + 1]) throw new Error('Unknown, repeated, or incomplete option.');
    flags[argv[i]] = argv[i + 1];
  }
  if (!['first-import', 'reconcile'].includes(flags['--mode'])) throw new Error('Choose --mode first-import or reconcile explicitly.');
  if (Boolean(flags['--audience']) === Boolean(flags['--database'])) throw new Error('Choose exactly one --audience export or --database.');
  if (flags['--mode'] === 'reconcile' && !flags['--listserv']) throw new Error('Reconciliation requires --listserv with a current roster.');
  if (!flags['--listserv'] && (flags['--listserv-format'] || flags['--listserv-email-column'])) throw new Error('Listserv parsing options require a roster file.');
  if (!flags['--output'] || !path.isAbsolute(flags['--output'])) throw new Error('Choose an absolute new --output directory.');
  const input = await readAudience(flags); let roster = null, rosterSource = null;
  if (flags['--listserv']) {
    const filename = await privateFile(flags['--listserv']), bytes = await readFile(filename);
    roster = listservRoster(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { format: flags['--listserv-format'], emailColumn: flags['--listserv-email-column'] });
    rosterSource = { filename, format: roster.format, emailColumn: roster.emailColumn, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const report = reconcile(normalizeAudience(input.rows), roster, { mode: flags['--mode'] });
  report.createdAt = new Date().toISOString(); report.inputs = { audience: input.source, listserv: rosterSource };
  const parent = await realpath(path.dirname(flags['--output'])), parentInfo = await stat(parent);
  if ((parentInfo.mode & 0o077) || (process.getuid && parentInfo.uid !== process.getuid())) throw new Error('Create the packet inside a private directory (700) owned by this account.');
  const destination = path.join(parent, path.basename(flags['--output'])); await outsideGit(destination);
  if (await exists(destination)) throw new Error('Output directory already exists; choose a new packet name.');
  await mkdir(destination, { mode: 0o700 });
  const files = {
    'README.txt': instructions(report),
    'reconciliation.json': JSON.stringify(report, null, 2) + '\n',
    'suppression_exclusions.csv': csv(report.suppressionExclusions, ['email', 'status']),
    'review_missing_from_listserv.csv': csv(report.localSubscribedMissingFromListserv, ['email', 'reason']),
    'review_held_records.csv': csv(report.heldForReview, ['email', 'status', 'reason'])
  };
  if (!report.reportOnly && report.initialImportCandidates.length) files['01_initial_subscribed_candidates.txt'] = report.initialImportCandidates.join('\n') + '\n';
  if (!report.reportOnly && report.removeLocalSuppressedPresentOnListserv.length) files['02_remove_local_suppressed_present_on_listserv.txt'] = report.removeLocalSuppressedPresentOnListserv.map(row => row.email).join('\n') + '\n';
  try {
    for (const [filename, content] of Object.entries(files)) await writeFile(path.join(destination, filename), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  return { ok: true, mode: report.mode, reportOnly: report.reportOnly, counts: report.counts, files: Object.keys(files), networkRequests: 0, emailsSent: 0, sourceDataChanged: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    const safe = ['Choose ', 'Use ', 'Supply ', 'Unknown,', 'Reconciliation ', 'Listserv parsing ', 'Create the packet', 'Output directory', 'First-import ', 'Keep private', 'Inputs must', 'Audience export', 'The selected Listserv', 'Specify ', 'Invalid CSV', 'Unclosed CSV', 'CSV ', 'Too many '].some(prefix => error.message.startsWith(prefix));
    console.error(safe ? error.message : 'The handoff could not be prepared. Check private paths and input format. No contact details were logged.'); process.exitCode = 1;
  });
}
