// Postgres local y desechable para las pruebas de pagos. Nunca toca la base real.
import EmbeddedPostgres from 'embedded-postgres';
import pgpkg from 'pg';
import os from 'os'; import path from 'path'; import fs from 'fs';

export async function startPg(port = 54329) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kami-pg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const pool = new pgpkg.Pool({ host: 'localhost', port, user: 'postgres', password: 'test', database: 'postgres', max: 20 });
  return { pool, stop: async () => { await pool.end(); await server.stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
