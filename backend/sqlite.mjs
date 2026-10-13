import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync, existsSync, lstatSync, realpathSync, statSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function privatePath(filename) {
  if (filename === ':memory:') return filename;
  if (!path.isAbsolute(filename)) throw new Error('Use an absolute private database path.');
  let parent = path.dirname(filename);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  parent = realpathSync(parent);
  const directory = statSync(parent);
  if ((directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error('Use a dedicated private directory (mode 700) owned by this account.');
  const resolved = path.join(parent, path.basename(filename));
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('Keep the database outside the website repository.');
  if (existsSync(resolved) && (!lstatSync(resolved).isFile() || lstatSync(resolved).isSymbolicLink())) throw new Error('The database must be a regular private file.');
  return resolved;
}

export class SQLiteStore {
  constructor(filename, { initialize = true } = {}) {
    this.filename = privatePath(filename);
    if (this.filename !== ':memory:' && !existsSync(this.filename)) closeSync(openSync(this.filename, 'wx', 0o600));
    this.database = new DatabaseSync(this.filename, { enableForeignKeyConstraints: true });
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (initialize) this.database.exec(schema);
    if (this.filename !== ':memory:') chmodSync(this.filename, 0o600);
  }
  prepare(sql) { return new SQLiteStatement(this, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        if (statement.store !== this) throw new Error('A transaction cannot mix databases.');
        return statement.execute();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  close() { this.database.close(); }
}

class SQLiteStatement {
  constructor(store, sql, parameters = []) { this.store = store; this.sql = sql; this.parameters = parameters; }
  bind(...parameters) { return new SQLiteStatement(this.store, this.sql, parameters); }
  execute() {
    const statement = this.store.database.prepare(this.sql);
    if (statement.columns().length) {
      const results = statement.all(...this.parameters);
      const changes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(this.sql) ? Number(this.store.database.prepare('SELECT changes() AS count').get().count) : 0;
      return { success: true, results, meta: { changes } };
    }
    const result = statement.run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first(column) { const result = this.execute().results[0] ?? null; return column && result ? result[column] : result; }
}
