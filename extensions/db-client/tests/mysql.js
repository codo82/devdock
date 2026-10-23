// MySQL usa e getta per i test del DB client: datadir temporanea, porta libera,
// nessun contatto con istanze già presenti. null se mysqld non è installato.
const { spawn, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { tmpDir } = require('../../../lib/testkit');

function findMysqld() {
  const candidates = [process.env.DEVDOCK_TEST_MYSQLD, '/opt/homebrew/opt/mysql/bin/mysqld', '/usr/local/opt/mysql/bin/mysqld', '/usr/sbin/mysqld'];
  const found = spawnSync('which', ['mysqld'], { encoding: 'utf8' }).stdout.trim();
  if (found) candidates.push(found);
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const portOpen = port => new Promise(resolve => {
  const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
});

// Avvia mysqld e crea l'utente devdock/devdock-pass con il database "app"
async function startMysql() {
  const mysqld = findMysqld();
  if (!mysqld) return null;
  const dir = tmpDir('devdock-mysql-');
  const data = path.join(dir, 'data');
  const port = await freePort();
  execFileSync(mysqld, ['--no-defaults', '--initialize-insecure', `--datadir=${data}`], { stdio: 'ignore' });
  const proc = spawn(mysqld, [
    '--no-defaults', `--datadir=${data}`, `--port=${port}`, '--bind-address=127.0.0.1',
    `--socket=${path.join(dir, 'mysql.sock')}`, `--pid-file=${path.join(dir, 'mysql.pid')}`,
    '--mysqlx=OFF', '--skip-log-bin', '--innodb-buffer-pool-size=16M', `--log-error=${path.join(dir, 'error.log')}`,
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await new Promise(r => setTimeout(r, 200));

  const mysql = require('mysql2/promise');
  const root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', multipleStatements: true });
  await root.query(`
    CREATE DATABASE app;
    CREATE USER 'devdock'@'%' IDENTIFIED BY 'devdock-pass';
    GRANT ALL ON app.* TO 'devdock'@'%';
    CREATE TABLE app.clienti (id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(50) NOT NULL, note TEXT NULL);
    INSERT INTO app.clienti (nome, note) VALUES ('Rossi', NULL), ('Bianchi', 'cliente storico'), ('Verdi', '');
  `);
  await root.end();

  return {
    port,
    stop: () => new Promise(resolve => {
      proc.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); });
      proc.kill('SIGTERM');
    }),
  };
}

module.exports = { startMysql };
