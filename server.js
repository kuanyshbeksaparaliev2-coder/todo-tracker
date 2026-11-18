'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const production = process.env.NODE_ENV === 'production';

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const app = createApp(db, { secureCookies: production, trustProxy: production });

const server = http.createServer(app.handler);
server.listen(PORT, () => console.log(`Сервер іске қосылды: http://localhost:${PORT}`));
setInterval(app.cleanup, 3600 * 1000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
