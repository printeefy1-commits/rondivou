import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appointmentTimes, extract } from './domain.js';
import { contextKey } from './ai.js';
export function createStore(path = '.data/rondivou.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, username TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(channel,external_id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), external_id TEXT NOT NULL, text TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL, historical INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id,external_id));
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), source_message_id TEXT UNIQUE REFERENCES messages(id), client_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', service TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reminder_sent_at TEXT, reminder_queued_start TEXT);
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, sent_at TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_updates(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ai_analyses(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), context_key TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS appointment_range ON appointments(start_at,end_at);
    CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,sent_at);
  `);
  const all = (q, ...args) => db.prepare(q).all(...args);
  const get = (q, ...args) => db.prepare(q).get(...args);
  const run = (q, ...args) => db.prepare(q).run(...args);
  const now = () => new Date().toISOString();
  function notify(kind, text) { const id = randomUUID(); run('INSERT INTO notifications(id,kind,text,created_at) VALUES(?,?,?,?)', id, kind, text, now()); }
  function enqueue(kind, payload) { run('INSERT INTO outbox(id,kind,payload,next_at) VALUES(?,?,?,?)', randomUUID(), kind, JSON.stringify(payload), now()); }
  function conversation(channel, externalId, username) {
    const existing = get('SELECT * FROM conversations WHERE channel=? AND external_id=?', channel, externalId);
    if (existing) return existing;
    const id = randomUUID();
    run('INSERT INTO conversations VALUES(?,?,?,?,?)', id, channel, externalId, username || externalId, now());
    return get('SELECT * FROM conversations WHERE id=?', id);
  }
  function context(id) {
    const last = get("SELECT m.sent_at FROM appointments a JOIN messages m ON m.id=a.source_message_id WHERE a.conversation_id=? ORDER BY m.sent_at DESC LIMIT 1", id);
    return all('SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE conversation_id=? AND sent_at>? ORDER BY sent_at DESC,rowid DESC LIMIT 30) ORDER BY sent_at,sequence', id, last?.sent_at || '');
  }
  function book(input, { updateId, reference = new Date() } = {}) {
    const { start, end } = appointmentTimes(input.date, input.time, input.service);
    if (new Date(start) <= reference) throw Object.assign(new Error('Le rendez-vous doit être dans le futur.'), { status: 400 });
    db.exec('BEGIN IMMEDIATE');
    try {
      if (updateId && !get('SELECT id FROM appointments WHERE id=?', updateId)) throw Object.assign(new Error('Rendez-vous introuvable.'), { status: 404 });
      if (input.source_message_id) {
        const existing = get('SELECT * FROM appointments WHERE source_message_id=?', input.source_message_id);
        if (existing && existing.id !== updateId) throw Object.assign(new Error('Ce message a déjà un rendez-vous.'), { status: 409 });
      }
      const conflict = get("SELECT id FROM appointments WHERE status!='cancelled' AND start_at<? AND end_at>? AND id!=?", end, start, updateId || '');
      if (conflict) throw Object.assign(new Error('Créneau indisponible : un autre rendez-vous occupe cette période.'), { status: 409 });
      const id = updateId || randomUUID(), stamp = now();
      if (updateId) run("UPDATE appointments SET client_name=?,phone=?,service=?,start_at=?,end_at=?,notes=?,status='confirmed',reminder_sent_at=NULL,reminder_queued_start=NULL,updated_at=? WHERE id=?", input.client_name || '', input.phone || '', input.service, start, end, input.notes || '', stamp, id);
      else run('INSERT INTO appointments(id,conversation_id,source_message_id,client_name,phone,service,start_at,end_at,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, input.conversation_id || null, input.source_message_id || null, input.client_name || '', input.phone || '', input.service, start, end, 'confirmed', input.notes || '', stamp, stamp);
      if (input.conversation_id) run("UPDATE reviews SET status='resolved' WHERE conversation_id=? AND status='pending'", input.conversation_id);
      const a = get('SELECT * FROM appointments WHERE id=?', id);
      const account = input.conversation_id && get('SELECT username,channel FROM conversations WHERE id=?', input.conversation_id);
      notify('booking', `${updateId ? 'Rendez-vous modifié' : 'Nouveau rendez-vous'} · ${input.date} à ${input.time} · ${input.service}`);
      enqueue('telegram', { text: `✅ ${updateId ? 'Rendez-vous modifié' : 'Rendez-vous confirmé'}\n${input.date} à ${input.time} · ${input.service}\n${input.client_name || 'Nom non renseigné'}${account ? `\n${account.channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${account.username}` : ''}` });
      db.exec('COMMIT'); return a;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function candidate(id) {
    const messages = context(id);
    const analysis = get('SELECT * FROM ai_analyses WHERE conversation_id=?', id);
    if (analysis && analysis.context_key === contextKey(messages)) return JSON.parse(analysis.result);
    return extract(messages);
  }
  return { db, all, get, run, now, notify, enqueue, conversation, context, book, candidate, close: () => db.close() };
}
