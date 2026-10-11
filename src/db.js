const path = require('path');
const fs = require('fs');
const knex = require('knex');
const { config } = require('./config');

function connection() {
  if (config.db.client === 'mysql') {
    return {
      client: 'mysql2',
      connection: {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        dateStrings: true, // keep DATE/DATETIME as strings: no timezone surprises
        charset: 'utf8mb4',
      },
      pool: { min: 0, max: 10 },
    };
  }
  const file = path.resolve(__dirname, '..', config.db.sqliteFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { afterCreate: (conn, done) => done(null, conn.pragma('foreign_keys = ON')) },
  };
}

const db = knex({
  ...connection(),
  migrations: { directory: path.join(__dirname, '..', 'migrations') },
});

// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings in both databases.
const now = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

async function migrate() {
  await db.migrate.latest();
}

module.exports = { db, now, migrate };
