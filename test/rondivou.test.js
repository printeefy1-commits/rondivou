import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { integrations } from '../src/integrations.js';
import { appointmentTimes, extract, isAgreement } from '../src/domain.js';

const future = '2030-06-10';
function setup(t, extra = {}) { const store = createStore(':memory:'); t.after(() => store.close()); return { store, integration: integrations(store, extra) }; }
const incoming = (extra = {}) => ({ channel: 'messenger', externalId: 'client-1', username: 'Sarah', messageId: 'm1', text: `${future} à 10h pour maquillage`, direction: 'in', sentAt: '2030-06-01T08:00:00Z', ...extra });

test('service durations and Algeria timezone; invalid dates rejected', () => {
  assert.deepEqual(appointmentTimes(future, '08:00', 'balayage'), { start: '2030-06-10T07:00:00.000Z', end: '2030-06-10T15:00:00.000Z' });
  assert.throws(() => appointmentTimes('2030-02-30', '10:00', 'coiffure'));
  assert.throws(() => appointmentTimes(future, '25:00', 'coiffure'));
});
test('French and Arabic extraction, relative date uses original message time', () => {
  const french = extract([{ text: 'Maquillage demain à 10h30', sent_at: '2030-06-01T23:30:00Z' }]);
  assert.equal(french.date, '2030-06-03'); assert.equal(french.time, '10:30'); assert.equal(french.service, 'maquillage'); assert.equal(french.complete, true);
  const arabic = extract([{ text: 'بالياج يوم 10/06/2030 على الساعة ٨:٠٠' }]);
  assert.equal(arabic.service, 'balayage'); assert.equal(arabic.time, '08:00'); assert.equal(arabic.date, future);
  assert.ok(isAgreement('Oui je confirme')); assert.ok(isAgreement('موعدك مؤكد'));
});
test('conflicting dates or multiple services force manual review', () => {
  const candidate = extract([{ text: `${future} ou 2030-06-11 à 10h coiffure ou coloration` }]);
  assert.equal(candidate.ambiguous, true); assert.equal(candidate.complete, false);
});
test('written French dates use message year and retain ambiguity between services', () => {
  const message = { text: 'Bonjour, je voudrais un rendez-vous pour une coloration le 23 octobre à 10h. , pour balayage', sent_at: '2026-10-20T16:16:00Z' };
  const result = extract([message]);
  assert.equal(result.date, '2026-10-23');
  assert.equal(result.time, '10:00');
  assert.equal(result.service, '');
  assert.equal(result.ambiguous, true);
  assert.equal(result.complete, false);
  const single = extract([{ ...message, text: 'Balayage le 1er août 2030 à 08h' }]);
  assert.equal(single.date, '2030-08-01');
  assert.equal(single.complete, true);
  assert.equal(extract([{ ...message, text: 'Balayage le 31 février à 10h' }]).complete, false);
  assert.equal(extract([{ ...message, text: 'Balayage le 23 octobre ou 24/10 à 10h' }]).ambiguous, true);
});
test('negated confirmations and questions do not create an agreement', () => {
  for (const text of ['Je ne confirme pas', 'Pouvez-vous confirmer ?', 'موعدك مؤكد؟', 'لا اكد الموعد', 'pas confirmé']) assert.equal(isAgreement(text), false, text);
});
test('single worker: overlaps blocked, adjacent appointments accepted, cancellation frees time', t => {
  const { store } = setup(t);
  const first = store.book({ date: future, time: '08:00', service: 'balayage' });
  assert.throws(() => store.book({ date: future, time: '15:00', service: 'maquillage' }), e => e.status === 409);
  store.book({ date: future, time: '16:00', service: 'coloration' });
  store.run("UPDATE appointments SET status='cancelled' WHERE id=?", first.id);
  assert.ok(store.book({ date: future, time: '08:00', service: 'coiffure' }).id);
});
test('complete conversation waits for explicit agreement; webhook replay creates no duplicates', t => {
  const { store, integration } = setup(t);
  integration.ingest(incoming());
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  integration.ingest(incoming({ messageId: 'm2', text: 'Oui je confirme', direction: 'out', sentAt: '2030-06-01T08:01:00Z' }));
  integration.ingest(incoming({ messageId: 'm2', text: 'Oui je confirme', direction: 'out', sentAt: '2030-06-01T08:01:00Z' }));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages').n, 2);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM reviews WHERE status='pending'").n, 0);
});
test('historical agreements never auto-book, including a later live confirmation', t => {
  const { store, integration } = setup(t);
  integration.ingest(incoming({ historical: true, text: `${future} à 10h maquillage, je confirme` }));
  integration.ingest(incoming({ messageId: 'm2', text: 'je confirme', sentAt: '2030-06-01T08:10:00Z' }));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  assert.equal(store.get('SELECT reason FROM reviews LIMIT 1').reason, 'historical');
});
test('cancellation request needs manager review and never cancels automatically', t => {
  const { store, integration } = setup(t);
  integration.ingest(incoming({ text: `${future} à 10h maquillage, je confirme` }));
  integration.ingest(incoming({ messageId: 'm2', text: 'Je veux annuler', sentAt: '2030-06-02T08:00:00Z' }));
  assert.equal(store.get('SELECT status FROM appointments').status, 'confirmed');
  assert.equal(store.get("SELECT reason FROM reviews WHERE status='pending'").reason, 'change_requested');
});
test('non-text attachments are ignored and both text directions are retained', t => {
  const { store, integration } = setup(t);
  integration.metaEvents({ object: 'page', entry: [{ id: 'page', messaging: [
    { sender: { id: 'client' }, recipient: { id: 'page' }, timestamp: Date.now(), message: { mid: 'audio', attachments: [{}] } },
    { sender: { id: 'client' }, recipient: { id: 'page' }, timestamp: Date.now(), message: { mid: 'text', text: 'Bonjour' } },
    { sender: { id: 'page' }, recipient: { id: 'client' }, timestamp: Date.now(), message: { mid: 'echo', text: 'Bienvenue', is_echo: true } }
  ] }] });
  const messages = store.all('SELECT * FROM messages ORDER BY rowid');
  assert.equal(messages.length, 2); assert.deepEqual(messages.map(m => m.direction), ['in', 'out']);
  assert.equal(messages[0].conversation_id, messages[1].conversation_id);
});
test('fixed evening reminders skip late bookings, queue once for manual bookings, and never auto-cancel', t => {
  const { store, integration } = setup(t);
  const a = store.book({ date: future, time: '10:00', service: 'maquillage' });
  store.run('UPDATE appointments SET created_at=? WHERE id=?', '2030-06-10T01:00:00Z', a.id);
  integration.scheduleReminders(new Date('2030-06-09T18:00:00Z'));
  assert.equal(store.get("SELECT COUNT(*) AS n FROM notifications WHERE kind='reminder'").n, 0);
  store.run('UPDATE appointments SET created_at=? WHERE id=?', '2030-06-01T01:00:00Z', a.id);
  integration.scheduleReminders(new Date('2030-06-09T18:00:00Z'));
  integration.scheduleReminders(new Date('2030-06-09T18:01:00Z'));
  assert.equal(store.get("SELECT COUNT(*) AS n FROM notifications WHERE kind='reminder'").n, 1);
  assert.equal(store.get('SELECT status FROM appointments').status, 'confirmed');
});
test('only authorized private Telegram account can act; old imports open form instead of booking', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const sent = [];
  const integration = integrations(store, { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_ADMIN_ID: '42', PUBLIC_URL: 'https://salon.example' }, async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: true }) }; });
  const result = integration.ingest(incoming({ historical: true, text: `${future} à 10h maquillage, je confirme` }));
  const body = { update_id: 1, callback_query: { id: 'cb1', data: `confirm:${result.conversation_id}`, from: { id: 99 }, message: { chat: { id: 99, type: 'private' } } } };
  await integration.telegramEvent(body); assert.equal(sent.length, 0);
  body.callback_query.from.id = 42; body.callback_query.message.chat.id = 42;
  await integration.telegramEvent(body); await integration.telegramEvent(body);
  assert.equal(sent.length, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  assert.match(store.all('SELECT payload FROM outbox ORDER BY rowid').at(-1).payload, /validation manuelle/);
});
test('Meta client errors preserve pending reminder and surface delivery failure', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-06-08T10:00:00Z')});
  const store = createStore(':memory:'); t.after(() => store.close());
  const integration = integrations(store, { META_PAGE_ACCESS_TOKEN: 'test', META_PAGE_ID: 'page' }, async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 10 } }) }));
  const c = store.conversation('messenger', 'c', 'Cliente');
  const a = store.book({ date: future, time: '10:00', service: 'maquillage', conversation_id: c.id });
  store.run('DELETE FROM outbox');
  t.mock.timers.setTime(Date.parse('2030-06-09T18:00:00Z')); integration.scheduleReminders();
  store.run("DELETE FROM outbox WHERE kind='telegram_reminder'");
  await integration.flush();
  assert.equal(store.get('SELECT status FROM appointments').status, 'confirmed');
  assert.equal(store.get('SELECT attempts FROM outbox').attempts, 1);
  assert.equal(store.get('SELECT reminder_sent_at FROM appointments').reminder_sent_at, null);
});
test('successful client reminder waits for confirmation; reply updates existing appointment', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-06-08T10:00:00Z')});
  const store = createStore(':memory:'); t.after(() => store.close());
  const integration = integrations(store, { META_PAGE_ACCESS_TOKEN: 'test', META_PAGE_ID: 'page' }, async () => ({ ok: true, json: async () => ({ message_id: 'reminder' }) }));
  const c = store.conversation('messenger', 'client-1', 'Sarah');
  const a = store.book({ date: future, time: '10:00', service: 'maquillage', conversation_id: c.id });
  store.run('DELETE FROM outbox');t.mock.timers.setTime(Date.parse('2030-06-09T18:00:00Z'));integration.scheduleReminders();store.run("DELETE FROM outbox WHERE kind='telegram_reminder'");
  await integration.flush(); assert.equal(store.get('SELECT status FROM appointments').status, 'waiting_confirmation');
  integration.ingest(incoming({ text: 'Je confirme', messageId: 'reply',sentAt:'2030-06-09T18:01:00Z' }));
  assert.equal(store.get('SELECT status FROM appointments').status, 'confirmed');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 1);
});
test('several pending appointments require human attendance review', t => {
  const { store, integration } = setup(t);
  const c = store.conversation('messenger', 'client-1', 'Sarah');
  for (const time of ['10:00', '12:00']) {
    const a = store.book({ date: future, time, service: 'maquillage', conversation_id: c.id });
    store.run("UPDATE appointments SET status='waiting_confirmation' WHERE id=?", a.id);
  }
  integration.ingest(incoming({ text: 'je confirme' }));
  assert.equal(store.get("SELECT COUNT(*) AS n FROM appointments WHERE status='waiting_confirmation'").n, 2);
  assert.equal(store.get('SELECT reason FROM reviews').reason, 'attendance_ambiguous');
});
test('long text is forwarded completely in Telegram-sized chunks', t => {
  const { store, integration } = setup(t);
  const text = 'a'.repeat(7000);
  integration.ingest(incoming({ text }));
  const jobs = store.all("SELECT payload FROM outbox WHERE kind='telegram'").map(j => JSON.parse(j.payload));
  assert.equal(jobs.length, 3);
  assert.equal(jobs.map(j => j.text.split('\n\n').at(-1)).join(''), text);
  assert.ok(jobs.every(j => j.text.length < 4096));
});
test('month import paginates messages and remains idempotent without creating bookings', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const calls = [];
  const integration = integrations(store, { META_PAGE_ACCESS_TOKEN: 'test', META_PAGE_ID: 'page', META_INSTAGRAM_ID: 'ig' }, async raw => {
    const url = new URL(raw); calls.push(url);
    let data;
    if (url.pathname.endsWith('/page/conversations')) data = url.searchParams.get('platform') === 'instagram' ? { data: [] } : { data: [{ id: 'conv', updated_time: new Date().toISOString(), participants: { data: [{ id: 'page' }, { id: 'client', name: 'Sarah' }] } }] };
    else data = { data: [{ id: url.searchParams.has('after') ? 'old2' : 'old1', message: `${future} à 10h maquillage, je confirme`, created_time: new Date().toISOString(), from: { id: 'client' } }], ...(url.searchParams.has('after') ? {} : { paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'cursor2' } } }) };
    return { ok: true, json: async () => data };
  });
  assert.equal(await integration.importHistory(), 2);
  assert.equal(await integration.importHistory(), 0);
  assert.ok(calls.some(u => u.searchParams.get('after') === 'cursor2'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages WHERE historical=1').n, 2);
});
test('HTTP auth, booking persistence/conflict, origin check, webhook signatures', async t => {
  const store = createStore(':memory:');
  const { app } = createApp(store, { ADMIN_PASSWORD: 'test-password', META_APP_SECRET: 'app-secret', TELEGRAM_WEBHOOK_SECRET: 'tg-secret' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/dashboard')).status, 401);
  assert.equal((await fetch(base + '/webhooks/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { 'Content-Type': 'application/json', cookie };
  assert.equal((await fetch(base + '/api/dashboard', { headers })).status, 200);
  const body = JSON.stringify({ date: future, time: '10:00', service: 'coloration' });
  assert.equal((await fetch(base + '/api/appointments', { method: 'POST', headers, body })).status, 201);
  assert.equal((await fetch(base + '/api/appointments', { method: 'POST', headers, body })).status, 409);
  assert.equal((await fetch(base + '/api/appointments', { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body })).status, 403);
  const event = JSON.stringify({ object: 'page', entry: [] });
  assert.equal((await fetch(base + '/webhooks/meta', { method: 'POST', headers, body: event })).status, 403);
  const signature = 'sha256=' + createHmac('sha256', 'app-secret').update(event).digest('hex');
  assert.equal((await fetch(base + '/webhooks/meta', { method: 'POST', headers: { ...headers, 'x-hub-signature-256': signature }, body: event })).status, 200);
});

test('Meta webhook audit distinguishes rejected and accepted requests without exposing messages or secrets', async t => {
  const store = createStore(':memory:');
  const records = [];
  const { app } = createApp(store, { ADMIN_PASSWORD: 'fixture-admin', META_APP_SECRET: 'fixture-app-secret' }, undefined, record => records.push(record));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}/webhooks/meta`;
  const text = JSON.stringify({ object: 'page', entry: [{ id: 'private-page-id', messaging: [{ sender: { id: 'private-sender-id' }, recipient: { id: 'private-page-id' }, timestamp: Date.now(), message: { mid: 'private-message-id', text: 'PRIVATE_CLIENT_MESSAGE' } }], changes: [{ field: 'PRIVATE_FIELD_NAME', value: 'PRIVATE_VALUE' }] }] });
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: text })).status, 403);
  const signature = 'sha256=' + createHmac('sha256', 'fixture-app-secret').update(text).digest('hex');
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': signature }, body: text })).status, 200);
  assert.equal(records.length, 2);
  assert.equal(records[0].reason, 'invalid_signature');
  assert.equal(records[1].reason, 'accepted');
  assert.equal(records[1].text_events, 1);
  assert.equal(records[1].messaging_events, 1);
  assert.deepEqual(records[1].changes_fields, ['other']);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages').n, 1);
  for (const secret of ['PRIVATE', 'private-sender', 'private-page', 'fixture-app-secret', signature]) assert.ok(!JSON.stringify(records).includes(secret));
});

test('conversation start comes from earliest available message, with latest-active conversations first', async t => {
  const store = createStore(':memory:');
  const { app, integration } = createApp(store, { ADMIN_PASSWORD: 'fixture-password' });
  const older = integration.ingest(incoming({ externalId: 'old-conv', messageId: 'first-live', text: 'Bonjour', sentAt: '2030-06-10T08:00:00Z' }));
  integration.ingest(incoming({ externalId: 'old-conv', messageId: 'imported-older', text: 'Ancien échange', historical: true, sentAt: '2030-05-20T08:00:00Z' }));
  const newer = integration.ingest(incoming({ externalId: 'new-conv', messageId: 'latest', text: 'Message récent', sentAt: '2030-06-11T08:00:00Z' }));
  store.run('INSERT INTO sessions VALUES(?,?)', 'abcdef', Date.now() + 60000);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: 'rondivou_session=abcdef' };
  const data = await (await fetch(base + '/api/dashboard', { headers })).json();
  assert.equal(data.conversations[0].id, newer.conversation_id);
  assert.equal(data.conversations[1].started_at, '2030-05-20T08:00:00.000Z');
  assert.equal(data.conversations[1].last_at, '2030-06-10T08:00:00.000Z');
  const detail = await (await fetch(base + '/api/conversations/' + older.conversation_id, { headers })).json();
  assert.equal(detail.started_at, '2030-05-20T08:00:00.000Z');
  // Keep API chronology intact: UI reverses a copy, while booking source remains the latest message.
  assert.equal(detail.messages.at(-1).external_id, 'first-live');
});
