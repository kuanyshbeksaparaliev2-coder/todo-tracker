'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

function start(opts) {
  const db = openDb(':memory:');
  const app = createApp(db, opts);
  const server = http.createServer(app.handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` }))
  );
}

// Cookie сақтайтын шағын клиент
function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, res };
  }
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

let ctx;
before(async () => { ctx = await start(); });
after(() => { ctx.server.close(); ctx.db.close(); });

async function registered(name) {
  const c = client(ctx.base);
  const r = await c.post('/api/register', { username: name, password: 'qwerty123' });
  assert.equal(r.status, 201);
  return c;
}

test('тіркелу: құпия сөз хэштелген түрде сақталады, сессия жұмыс істейді', async () => {
  const c = await registered('aibek');
  const me = await c.get('/api/me');
  assert.equal(me.data.user.username, 'aibek');
  const row = ctx.db.prepare("SELECT password_hash FROM users WHERE username = 'aibek'").get();
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes('qwerty123'));
  const cats = await c.get('/api/categories');
  assert.equal(cats.data.length, 3);
});

test('тіркелу валидациясы және қайталанатын логин', async () => {
  const c = client(ctx.base);
  assert.equal((await c.post('/api/register', { username: 'ab', password: 'qwerty123' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'valid_name', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'bad name!', password: 'qwerty123' })).status, 400);
  await registered('dupuser');
  assert.equal((await c.post('/api/register', { username: 'DUPUSER', password: 'qwerty123' })).status, 409);
});

test('кіру: дұрыс және қате құпия сөз, шығу', async () => {
  await registered('login_user');
  const c = client(ctx.base);
  assert.equal((await c.post('/api/login', { username: 'login_user', password: 'wrongpass1' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'nobody', password: 'qwerty123' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'login_user', password: 'qwerty123' })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.username, 'login_user');
  await c.post('/api/logout', {});
  assert.equal((await c.get('/api/tasks')).status, 401);
});

test('тапсырмалар CRUD', async () => {
  const c = await registered('crud_user');
  const cat = (await c.get('/api/categories')).data[0];
  const created = await c.post('/api/tasks', { title: '  СӨЖ жазу ', priority: 1, due_date: '2026-12-01', category_id: cat.id });
  assert.equal(created.status, 201);
  assert.equal(created.data.title, 'СӨЖ жазу');
  assert.equal(created.data.category_name, cat.name);
  const id = created.data.id;

  const upd = await c.put(`/api/tasks/${id}`, { done: true, title: 'СӨЖ тапсыру' });
  assert.equal(upd.data.done, true);
  assert.equal(upd.data.title, 'СӨЖ тапсыру');
  assert.equal(upd.data.priority, 1);

  const done = await c.get('/api/tasks?status=done');
  assert.equal(done.data.length, 1);
  assert.equal((await c.get('/api/tasks?status=active')).data.length, 0);

  const stats = await c.get('/api/stats?today=2027-01-01');
  assert.deepEqual(stats.data, { total: 1, done: 1, overdue: 0 });

  assert.equal((await c.del(`/api/tasks/${id}`)).status, 200);
  assert.equal((await c.del(`/api/tasks/${id}`)).status, 404);
});

test('валидация: қате деректер 400 қайтарады', async () => {
  const c = await registered('valid_user');
  assert.equal((await c.post('/api/tasks', { title: '   ' })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'ok', priority: 9 })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'ok', due_date: '2026-02-31' })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'ok', category_id: 99999 })).status, 400);
  assert.equal((await c.post('/api/categories', { name: 'a', color: 'red' })).status, 400);
  const bad = await fetch(ctx.base + '/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: '' },
    body: '{broken',
  });
  assert.ok([400, 401].includes(bad.status));
});

test('қолданушылар бір-бірінің деректерін көре алмайды', async () => {
  const a = await registered('owner_a');
  const b = await registered('owner_b');
  const task = (await a.post('/api/tasks', { title: 'Құпия тапсырма' })).data;
  const catA = (await a.get('/api/categories')).data[0];

  assert.equal((await b.get('/api/tasks')).data.length, 0);
  assert.equal((await b.put(`/api/tasks/${task.id}`, { done: true })).status, 404);
  assert.equal((await b.del(`/api/tasks/${task.id}`)).status, 404);
  assert.equal((await b.post('/api/tasks', { title: 'x', category_id: catA.id })).status, 400);
  assert.equal((await b.del(`/api/categories/${catA.id}`)).status, 404);
  assert.equal((await a.get('/api/tasks')).data.length, 1);
});

test('SQL-инъекция сөзжолдары қауіпсіз өңделеді', async () => {
  const c = await registered('sqli_user');
  const evil = "'); DROP TABLE tasks; --";
  const r = await c.post('/api/tasks', { title: evil });
  assert.equal(r.status, 201);
  assert.equal(r.data.title, evil);
  await c.post('/api/tasks', { title: 'қарапайым' });
  const s = await c.get('/api/tasks?q=' + encodeURIComponent("' OR '1'='1"));
  assert.equal(s.status, 200);
  assert.equal(s.data.length, 0);
  const s2 = await c.get('/api/tasks?q=' + encodeURIComponent('%'));
  assert.equal(s2.data.length, 0); // % әріптік таңба ретінде ізделеді
  assert.equal((await c.get('/api/tasks')).data.length, 2);
  const login = await client(ctx.base).post('/api/login', { username: "' OR 1=1 --", password: 'x' });
  assert.equal(login.status, 401);
});

test('санатты өшіргенде тапсырма сақталады, санаты бос болады', async () => {
  const c = await registered('cat_user');
  const cat = (await c.post('/api/categories', { name: 'Уақытша', color: '#112233' })).data;
  assert.equal((await c.post('/api/categories', { name: 'уақытша' })).status, 409);
  const t = (await c.post('/api/tasks', { title: 'Тест', category_id: cat.id })).data;
  assert.equal((await c.del(`/api/categories/${cat.id}`)).status, 200);
  const after = (await c.get('/api/tasks')).data.find((x) => x.id === t.id);
  assert.equal(after.category_id, null);
  const none = await c.get('/api/tasks?category=none');
  assert.equal(none.data.length, 1);
});

test('қорғаныс: авторизациясыз 401, CSRF тақырыбынсыз 403, қауіпсіздік тақырыптары', async () => {
  const anon = client(ctx.base);
  assert.equal((await anon.get('/api/tasks')).status, 401);
  assert.equal((await anon.get('/api/me')).data.user, null);
  const noHeader = await fetch(ctx.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: 'b' }),
  });
  assert.equal(noHeader.status, 403);
  const page = await fetch(ctx.base + '/');
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const reg = await client(ctx.base).post('/api/register', { username: 'cookie_user', password: 'qwerty123' });
  const sc = reg.res.headers.get('set-cookie');
  assert.ok(sc.includes('HttpOnly') && sc.includes('SameSite=Lax'));
});

test('статикалық файлдарда path traversal жұмыс істемейді', async () => {
  const r = await fetch(ctx.base + '/..%2Fpackage.json');
  assert.equal(r.status, 404);
  const r2 = await fetch(ctx.base + '/%2e%2e/server.js');
  assert.equal(r2.status, 404);
});

test('кіру әрекеттерінің шектеуі (rate limit) 429 қайтарады', async () => {
  const lim = await start({ authLimit: 3 });
  try {
    const c = client(lim.base);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/login', { username: 'x', password: 'y' })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  } finally {
    lim.server.close();
    lim.db.close();
  }
});
