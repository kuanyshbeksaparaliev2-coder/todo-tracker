'use strict';
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const v = require('./validate');
const { HttpError } = require('./errors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 16 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const keyOf = (s) => s.toLowerCase();
const DEFAULT_CATEGORIES = [['Оқу', '#3d5afe'], ['Жұмыс', '#e8960c'], ['Жеке', '#2e9e6b']];

function createApp(db, opts = {}) {
  const { secureCookies = false, trustProxy = false, authLimit = 20 } = opts;
  const hits = new Map();

  // ---------- көмекші функциялар ----------
  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk) => {
        if (tooBig) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          tooBig = true;
          reject(new HttpError(413, 'Сұраныс тым үлкен'));
        } else chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function parseJson(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type: application/json қажет');
    }
    const raw = await readBody(req);
    if (!raw) return {};
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'JSON дұрыс емес');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpError(400, 'JSON объект болуы керек');
    }
    return data;
  }

  function rateLimit(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = (trustProxy && forwarded) || req.socket.remoteAddress;
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + 15 * 60 * 1000 };
      hits.set(ip, h);
    }
    if (++h.n > authLimit) throw new HttpError(429, 'Тым көп әрекет. 15 минуттан кейін қайталаңыз');
  }

  // ---------- SQL (барлығы параметрленген, SQL-инъекциядан қорғау) ----------
  const q = {
    userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username_key = ?'),
    insUser: db.prepare('INSERT INTO users (username, username_key, password_hash) VALUES (?, ?, ?)'),
    insCat: db.prepare('INSERT INTO categories (user_id, name, name_key, color) VALUES (?, ?, ?, ?)'),
    cats: db.prepare(
      `SELECT c.id, c.name, c.color,
              (SELECT COUNT(*) FROM tasks t WHERE t.category_id = c.id) AS task_count
       FROM categories c WHERE c.user_id = ? ORDER BY c.name`
    ),
    catById: db.prepare('SELECT id, name, color FROM categories WHERE id = ? AND user_id = ?'),
    updCat: db.prepare('UPDATE categories SET name = ?, name_key = ?, color = ? WHERE id = ? AND user_id = ?'),
    delCat: db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?'),
    taskById: db.prepare(
      `SELECT t.id, t.title, t.priority, t.due_date, t.done, t.category_id,
              c.name AS category_name, c.color AS category_color
       FROM tasks t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id = ? AND t.user_id = ?`
    ),
    insTask: db.prepare(
      'INSERT INTO tasks (user_id, category_id, title, priority, due_date) VALUES (?, ?, ?, ?, ?)'
    ),
    updTask: db.prepare(
      'UPDATE tasks SET title = ?, priority = ?, due_date = ?, done = ?, category_id = ? WHERE id = ? AND user_id = ?'
    ),
    delTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
    stats: db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(done), 0) AS done,
              COALESCE(SUM(CASE WHEN done = 0 AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM tasks WHERE user_id = ?`
    ),
  };

  const taskOut = (r) => ({ ...r, done: !!r.done });

  function ownCategoryId(value, userId) {
    if (value === null || value === undefined || value === '') return null;
    if (!Number.isInteger(value) || !q.catById.get(value, userId)) {
      throw new HttpError(400, 'Санат табылмады');
    }
    return value;
  }

  // ---------- маршруттар ----------
  const routes = [];
  const route = (method, pattern, handler, { pub = false } = {}) =>
    routes.push({
      method,
      re: new RegExp('^' + pattern.replace(':id', '(\\d+)') + '$'),
      handler,
      pub,
      hasBody: method === 'POST' || method === 'PUT',
    });

  route('POST', '/api/register', async ({ req, body }) => {
    rateLimit(req);
    const username = v.username(body.username);
    const password = v.password(body.password);
    if (q.userByName.get(keyOf(username))) throw new HttpError(409, 'Бұл логин бос емес');
    const hash = await auth.hashPassword(password);
    let id;
    try {
      id = Number(q.insUser.run(username, keyOf(username), hash).lastInsertRowid);
    } catch {
      throw new HttpError(409, 'Бұл логин бос емес');
    }
    DEFAULT_CATEGORIES.forEach(([name, color]) => q.insCat.run(id, name, keyOf(name), color));
    const token = auth.createSession(db, id);
    return [201, { user: { id, username } }, { 'Set-Cookie': auth.cookie(token, secureCookies) }];
  }, { pub: true });

  route('POST', '/api/login', async ({ req, body }) => {
    rateLimit(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' && body.password.length <= 100 ? body.password : '';
    const user = q.userByName.get(keyOf(username));
    const ok = await auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Логин немесе құпия сөз қате');
    const token = auth.createSession(db, user.id);
    return [200, { user: { id: user.id, username: user.username } }, { 'Set-Cookie': auth.cookie(token, secureCookies) }];
  }, { pub: true });

  route('POST', '/api/logout', ({ req }) => {
    auth.destroySession(db, req);
    return [200, { ok: true }, { 'Set-Cookie': auth.cookie(null, secureCookies) }];
  }, { pub: true });

  route('GET', '/api/me', ({ user }) => [200, { user }], { pub: true });

  route('GET', '/api/categories', ({ user }) => [200, q.cats.all(user.id)]);

  route('POST', '/api/categories', ({ user, body }) => {
    const name = v.categoryName(body.name);
    const color = body.color === undefined ? '#3d5afe' : v.color(body.color);
    try {
      const id = Number(q.insCat.run(user.id, name, keyOf(name), color).lastInsertRowid);
      return [201, { id, name, color, task_count: 0 }];
    } catch {
      throw new HttpError(409, 'Мұндай санат бар');
    }
  });

  route('PUT', '/api/categories/:id', ({ user, id, body }) => {
    const cur = q.catById.get(id, user.id);
    if (!cur) throw new HttpError(404, 'Санат табылмады');
    const name = body.name === undefined ? cur.name : v.categoryName(body.name);
    const color = body.color === undefined ? cur.color : v.color(body.color);
    try {
      q.updCat.run(name, keyOf(name), color, id, user.id);
    } catch {
      throw new HttpError(409, 'Мұндай санат бар');
    }
    return [200, { id, name, color }];
  });

  route('DELETE', '/api/categories/:id', ({ user, id }) => {
    if (q.delCat.run(id, user.id).changes === 0) throw new HttpError(404, 'Санат табылмады');
    return [200, { ok: true }];
  });

  route('GET', '/api/tasks', ({ user, url }) => {
    let sql =
      `SELECT t.id, t.title, t.priority, t.due_date, t.done, t.category_id,
              c.name AS category_name, c.color AS category_color
       FROM tasks t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = ?`;
    const params = [user.id];
    const status = url.searchParams.get('status');
    if (status === 'active') sql += ' AND t.done = 0';
    else if (status === 'done') sql += ' AND t.done = 1';
    const cat = url.searchParams.get('category');
    if (cat === 'none') sql += ' AND t.category_id IS NULL';
    else if (cat && /^\d+$/.test(cat)) {
      sql += ' AND t.category_id = ?';
      params.push(Number(cat));
    }
    const search = v.search(url.searchParams.get('q'));
    if (search) {
      sql += " AND t.title LIKE ? ESCAPE '\\'";
      params.push('%' + search.replace(/[\\%_]/g, '\\$&') + '%');
    }
    sql += ' ORDER BY t.done, t.priority, t.due_date IS NULL, t.due_date, t.id DESC';
    return [200, db.prepare(sql).all(...params).map(taskOut)];
  });

  route('GET', '/api/stats', ({ user, url }) => {
    const today = v.dueDate(url.searchParams.get('today') || new Date().toISOString().slice(0, 10));
    const s = q.stats.get(today, user.id);
    return [200, { total: s.total, done: s.done, overdue: s.overdue }];
  });

  route('POST', '/api/tasks', ({ user, body }) => {
    const title = v.title(body.title);
    const priority = body.priority === undefined ? 2 : v.priority(body.priority);
    const due = v.dueDate(body.due_date === undefined ? null : body.due_date);
    const categoryId = ownCategoryId(body.category_id, user.id);
    const id = Number(q.insTask.run(user.id, categoryId, title, priority, due).lastInsertRowid);
    return [201, taskOut(q.taskById.get(id, user.id))];
  });

  route('PUT', '/api/tasks/:id', ({ user, id, body }) => {
    const cur = q.taskById.get(id, user.id);
    if (!cur) throw new HttpError(404, 'Тапсырма табылмады');
    const title = body.title === undefined ? cur.title : v.title(body.title);
    const priority = body.priority === undefined ? cur.priority : v.priority(body.priority);
    const due = body.due_date === undefined ? cur.due_date : v.dueDate(body.due_date);
    const done = body.done === undefined ? cur.done : (v.done(body.done) ? 1 : 0);
    const categoryId = body.category_id === undefined ? cur.category_id : ownCategoryId(body.category_id, user.id);
    q.updTask.run(title, priority, due, done, categoryId, id, user.id);
    return [200, taskOut(q.taskById.get(id, user.id))];
  });

  route('DELETE', '/api/tasks/:id', ({ user, id }) => {
    if (q.delTask.run(id, user.id).changes === 0) throw new HttpError(404, 'Тапсырма табылмады');
    return [200, { ok: true }];
  });

  async function api(req, res, url) {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      // CSRF: басқа сайттың формасы бұл тақырыпты жібере алмайды
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') {
        throw new HttpError(403, 'Рұқсат етілмеген сұраныс');
      }
      const user = auth.userFromRequest(db, req);
      if (!r.pub && !user) throw new HttpError(401, 'Алдымен жүйеге кіріңіз');
      const body = r.hasBody ? await parseJson(req) : {};
      const [status, data, headers] = await r.handler({ req, url, user, id: m[1] ? Number(m[1]) : null, body });
      return send(res, status, data, headers);
    }
    throw pathMatched ? new HttpError(405, 'Әдіс рұқсат етілмеген') : new HttpError(404, 'Табылмады');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Әдіс рұқсат етілмеген');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Жарамсыз сұраныс');
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.includes('\0')) throw new HttpError(404, 'Табылмады');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Табылмады' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  async function handler(req, res) {
    for (const [k, val] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, val);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Сервер қатесі' });
    }
  }

  function cleanup() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const now = Date.now();
    for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
  }

  return { handler, cleanup };
}

module.exports = { createApp };
