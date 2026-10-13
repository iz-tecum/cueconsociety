import { readFile, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { emptyState, mergeImports, parseCsv, exportRecords, recordsToCsv } = require('../lib/newsletter.js');
const { createBlobStore, transact, MAX_STATE_BYTES } = require('../lib/newsletter-store.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function optionsFor(args) {
  const [command, ...rest] = args;
  if (!['import', 'export'].includes(command)) throw new Error('Use import --input FILE --source LABEL [--status STATUS] [--apply], or export --output FILE [--active-only] [--overwrite].');
  const values = { command };
  const booleans = new Set(['apply', 'active-only', 'overwrite']);
  const named = new Set(['input', 'output', 'source', 'status']);
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || Object.hasOwn(values, key)) throw new Error('Invalid or repeated command option.');
    if (booleans.has(key)) values[key] = true;
    else if (named.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) values[key] = rest[++i];
    else throw new Error('Invalid command option.');
  }
  return values;
}

async function privateOutput(filename, data, overwrite) {
  const target = path.resolve(filename);
  let parent = path.dirname(target);
  while (true) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  const relative = path.relative(await realpath(repoRoot), parent);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Save recipient exports outside the public website repository.');
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (overwrite) {
    try {
      const resolved = await realpath(target);
      if (resolved !== target) throw new Error('Refusing to overwrite a linked file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (overwrite ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(target, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(data);
  } finally { await handle.close(); }
  return target;
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const store = createBlobStore();
  if (options.command === 'import') {
    if (!options.input || !options.source) throw new Error('Import requires --input and --source.');
    const bytes = await readFile(path.resolve(options.input));
    if (bytes.length > MAX_STATE_BYTES) throw new Error('Input exceeds the private store size limit.');
    const rows = path.extname(options.input).toLowerCase() === '.csv' ? parseCsv(bytes.toString('utf8')) : JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('Import requires a nonempty array of contacts.');
    const at = new Date().toISOString();
    const settings = { at, source: options.source, status: options.status };
    let stats;
    if (options.apply) stats = await transact(store, state => mergeImports(state, rows, settings));
    else {
      const current = await store.read();
      stats = mergeImports(current?.state || emptyState(), rows, settings).result;
    }
    process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'applied' : 'dry-run', ...stats }, null, 2)}\n`);
  } else {
    if (!options.output || !['.csv', '.json'].includes(path.extname(options.output).toLowerCase())) throw new Error('Export requires --output with .csv or .json extension.');
    const current = await store.read();
    if (!current) throw new Error('The audience has not been initialized.');
    const records = exportRecords(current.state, { activeOnly: options['active-only'] === true });
    const data = path.extname(options.output).toLowerCase() === '.csv' ? recordsToCsv(records) : `${JSON.stringify(records, null, 2)}\n`;
    const target = await privateOutput(options.output, data, options.overwrite === true);
    process.stdout.write(`${JSON.stringify({ mode: 'exported', records: records.length, activeOnly: Boolean(options['active-only']), output: target }, null, 2)}\n`);
  }
}

main().catch(error => {
  const message = error instanceof SyntaxError ? 'Import or stored audience contains invalid JSON.' :
    error.message?.startsWith('Vercel Blob') ? 'Private storage could not be accessed. Check its connection and try again.' : error.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
