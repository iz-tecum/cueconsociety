import { readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { SQLiteStore, privatePath } from './sqlite.mjs';
import { importRecords, normalizeImportRecord } from './import.mjs';
import { csvCell } from './worker.mjs';

export function getRecords(input) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : input?.subscribers && typeof input.subscribers === 'object' ? Object.values(input.subscribers) : null;
  if (!Array.isArray(rows) || !rows.length || rows.length > 25000) throw new Error('Use a full audience array or a legacy state containing subscribers.');
  return rows;
}
async function writePrivate(filename, content) {
  const destination = privatePath(filename);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, destination);
}

export async function run(argv) {
  const [command, ...args] = argv, flags = {};
  if (!['import', 'export', 'stats', 'backup'].includes(command) || args.length % 2) throw new Error('Use import/export/stats/backup with --database and relevant --source/--output flags.');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--database', '--source', '--output', '--format'].includes(args[i]) || !args[i + 1] || flags[args[i]]) throw new Error('Invalid or repeated argument.');
    flags[args[i]] = args[i + 1];
  }
  if (!flags['--database']) throw new Error('An absolute --database path is required.');
  let rows;
  if (command === 'import') {
    if (!flags['--source'] || !path.isAbsolute(flags['--source'])) throw new Error('An absolute --source path is required.');
    const info = await stat(flags['--source']);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('The import file is too large or invalid.');
    rows = getRecords(JSON.parse(await readFile(flags['--source'], 'utf8')));
    const normalized = await Promise.all(rows.map(row => normalizeImportRecord(row)));
    if (new Set(normalized.map(row => row.email)).size !== rows.length) throw new Error('The import contains duplicate contacts.');
  }
  const database = new SQLiteStore(flags['--database']);
  try {
    if (['export', 'backup'].includes(command)) {
      if (!flags['--output']) throw new Error('An absolute private --output path is required.');
      const destination = privatePath(flags['--output']);
      if ([database.filename, `${database.filename}-wal`, `${database.filename}-shm`, `${database.filename}-journal`].includes(destination)) throw new Error('The output must not replace the database or its journal files.');
    }
    if (command === 'import') {
      const backupFile = `${database.filename}.before-import-${Date.now()}.sqlite`;
      await backup(database.database, backupFile);
      await chmod(backupFile, 0o600);
      for (let start = 0; start < rows.length; start += 100) {
        const result = await importRecords(database, rows.slice(start, start + 100));
        if (result.skippedAtCapacity) throw new Error('The audience limit was reached; use the pre-import backup if the import must be rolled back.');
      }
    }
    if (command === 'backup') {
      if (!flags['--output']) throw new Error('An absolute private --output path is required.');
      const destination = privatePath(flags['--output']);
      if (destination === database.filename) throw new Error('The backup must use a different path.');
      await backup(database.database, destination);
      await chmod(destination, 0o600);
    }
    if (command === 'export') {
      if (!flags['--output']) throw new Error('An absolute private --output path is required.');
      const format = flags['--format'] || 'json';
      if (!['json', 'csv', 'migration'].includes(format)) throw new Error('Use json, csv, or migration format.');
      const result = await database.prepare('SELECT * FROM contacts ORDER BY email').all();
      const records = result.results.map(row => ({
        ...JSON.parse(row.record_json), id: row.id, email: row.email, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
        ...(format === 'migration' && row.unsubscribe_token_hash ? { unsubscribeTokenHash: row.unsubscribe_token_hash } : {})
      }));
      const columns = ['id', 'email', 'name', 'status', 'interests', 'createdAt', 'updatedAt', 'consent', 'sources'];
      const content = format === 'csv' ? [columns.map(csvCell).join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\r\n') + '\r\n' : JSON.stringify(records, null, 2) + '\n';
      await writePrivate(flags['--output'], content);
    }
    const counts = await database.prepare('SELECT status,COUNT(*) AS count FROM contacts GROUP BY status ORDER BY status').all();
    return { ok: true, action: command, total: counts.results.reduce((sum, row) => sum + row.count, 0), statuses: Object.fromEntries(counts.results.map(row => [row.status, row.count])) };
  } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Audience operation failed. Check the command, private paths, and input records. No contact details were logged.'); process.exitCode = 1;
  });
}
