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
  try {
    require.resolve('better-sqlite3');
  } catch {
    throw new Error('The SQLite driver (better-sqlite3) is not installed. On a server, use MySQL: set DB_CLIENT=mysql and the DB_* settings.');
  }
  const file = path.resolve(__dirname, '..', config.db.sqliteFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {} // reported when the first query fails, without stopping the website
  return {
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { afterCreate: (conn, done) => done(null, conn.pragma('foreign_keys = ON')) },
  };
}

// The connection is created on first use, so a missing driver or bad settings surface as an
// error the server can catch (the website keeps running) instead of crashing at startup.
let instance;
function getDb() {
  instance ||= knex({ ...connection(), migrations: { directory: path.join(__dirname, '..', 'migrations') } });
  return instance;
}
const db = new Proxy(function () {}, {
  apply: (_target, _this, args) => getDb()(...args),
  get: (_target, prop) => {
    const value = getDb()[prop];
    return typeof value === 'function' ? value.bind(getDb()) : value;
  },
});

// Timestamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings in both databases.
const now = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

async function migrate() {
  await db.migrate.latest();
}

module.exports = { db, now, migrate };
