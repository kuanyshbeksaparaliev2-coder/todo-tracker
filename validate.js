'use strict';
const { HttpError } = require('./errors');

const bad = (msg) => new HttpError(400, msg);

function str(value, name) {
  if (typeof value !== 'string') throw bad(`${name} мәтін болуы керек`);
  return value.trim();
}

exports.username = (v) => {
  const s = str(v, 'Логин');
  if (!/^[\p{L}\p{N}_.-]{3,30}$/u.test(s)) {
    throw bad('Логин 3–30 таңба: әріп, сан, _ . - рұқсат етілген');
  }
  return s;
};

exports.password = (v) => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 100) {
    throw bad('Құпия сөз 8–100 таңба болуы керек');
  }
  return v;
};

exports.title = (v) => {
  const s = str(v, 'Тапсырма');
  if (s.length < 1 || s.length > 200) throw bad('Тапсырма 1–200 таңба болуы керек');
  return s;
};

exports.priority = (v) => {
  if (!Number.isInteger(v) || v < 1 || v > 3) throw bad('Маңыздылық 1, 2 немесе 3 болуы керек');
  return v;
};

exports.dueDate = (v) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Мерзім ЖЖЖЖ-АА-КК пішімінде болуы керек');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('Мерзім жарамсыз');
  return v;
};

exports.done = (v) => {
  if (typeof v !== 'boolean') throw bad('"done" true немесе false болуы керек');
  return v;
};

exports.categoryName = (v) => {
  const s = str(v, 'Санат атауы');
  if (s.length < 1 || s.length > 40) throw bad('Санат атауы 1–40 таңба болуы керек');
  return s;
};

exports.color = (v) => {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad('Түс #RRGGBB пішімінде болуы керек');
  return v.toLowerCase();
};

exports.search = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');
