import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { integrations } from '../src/integrations.js';
const config = { TELEGRAM_COMPACT: 'true', TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_ADMIN_ID: '7', PUBLIC_URL: 'https://salon.example' };
function setup(t, override, path = ':memory:') {
  const store = createStore(path); t.after(() => store.close());
  const calls = [];
  const request = async (url, options) => {
    const body = JSON.parse(options.body || '{}'); calls.push({ url, body });
    if (override) { const response = await override(url, body); if (response) return response; }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }));
  };
  const integration = integrations(store, config, request);
  let sequence = 0;
  const ingest = (text, extra = {}) => integration.ingest({ channel: 'instagram', externalId: 'client-id', username: 'client_name', messageId: 'm' + (++sequence), direction: 'in', sentAt: new Date(Date.now() + sequence * 1000).toISOString(), text, ...extra });
  const drain = async () => {
    store.run("UPDATE outbox SET next_at='2000-01-01T00:00:00Z' WHERE kind='telegram_card' AND error IS NULL");
    for (let i = 0; i < 10 && store.get('SELECT id FROM outbox WHERE sent_at IS NULL AND next_at<=?', store.now()); i++) await integration.flush();
  };
  return { store, calls, integration, ingest, drain };
}

test('rapid messages in both directions create one card with a site link and full website history', async t => {
  const { store, calls, ingest, drain } = setup(t);
  const { conversation_id: id } = ingest('Bonjour');
  ingest('Bonjour madame', { direction: 'out' }); ingest('Je veux des informations');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='telegram_card'").n, 1);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='telegram'").n, 0);
  await drain();
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.ok(calls[0].body.text.includes('client_name')); assert.ok(calls[0].body.text.includes('Salon'));
  assert.ok(calls[0].body.reply_markup.inline_keyboard[1][0].url.includes(id));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages').n, 3);
  ingest('Merci'); await drain();
  assert.equal(calls.length, 2); assert.ok(calls[1].url.endsWith('/editMessageText'));
  assert.equal(calls[1].body.message_id, 123);
  assert.ok(calls[1].body.text.includes('Merci'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM telegram_cards').n, 1);
});

test('profile updates and unchanged AI/form refreshes edit or skip rather than sending new cards', async t => {
  const { store, calls, ingest, drain, integration } = setup(t);
  const { conversation_id: id } = ingest('Bonjour'); await drain();
  store.run('UPDATE conversations SET username=? WHERE id=?', 'resolved_username', id);
  integration.refreshCard(id); await drain();
  assert.ok(calls[1].url.endsWith('/editMessageText')); assert.ok(calls[1].body.text.includes('resolved_username'));
  integration.refreshCard(id); await drain();
  assert.equal(calls.length, 2);
});

test('cards survive a store/application restart without sending a new message', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'rondivou-card-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'test.sqlite');
  const first = createStore(path);
  const id = first.conversation('instagram', 'persistent-client', 'name').id;
  first.run('INSERT INTO telegram_cards VALUES(?,?,?,?,?)', id, '7', '987', 'old', first.now());
  first.close();
  const { calls, integration, drain } = setup(t, undefined, path);
  integration.refreshCard(id); await drain();
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/editMessageText')); assert.equal(calls[0].body.message_id, 987);
});

test('temporary Telegram failures retain the original card and retry without duplicates', async t => {
  const { store, calls, ingest, drain } = setup(t, url => url.endsWith('/editMessageText') ? new Response(JSON.stringify({ok:false,error_code:429,description:'Too Many Requests'}), {status:429}) : null);
  ingest('Bonjour'); await drain(); ingest('Une question'); await drain();
  assert.equal(calls.filter(c => c.url.endsWith('/sendMessage')).length, 1);
  assert.equal(store.get("SELECT attempts FROM outbox WHERE kind='telegram_card' AND sent_at IS NULL").attempts, 1);
});

test('deleted card is replaced once and its new identifier saved', async t => {
  const { calls, ingest, drain } = setup(t, url => url.endsWith('/editMessageText') ? new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message to edit not found'}), {status:400}) : null);
  ingest('Bonjour'); await drain(); ingest('Une question'); await drain();
  assert.equal(calls.filter(c => c.url.endsWith('/sendMessage')).length, 2);
  assert.equal(calls.filter(c => c.url.endsWith('/editMessageText')).length, 1);
});

test('already applied edits are acknowledged without creating duplicate cards', async t => {
  const { store, calls, ingest, drain } = setup(t, url => url.endsWith('/editMessageText') ? new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message is not modified: specified new message content and reply markup are exactly the same'}), {status:400}) : null);
  ingest('Bonjour'); await drain(); ingest('Merci'); await drain();
  assert.equal(calls.filter(c => c.url.endsWith('/sendMessage')).length, 1);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL").n, 0);
});

test('long conversation previews remain within Telegram limits without truncating saved messages', async t => {
  const { store, calls, ingest, drain } = setup(t);
  const long = '😀'.repeat(9000);
  ingest(long); ingest(long); ingest(long); await drain();
  assert.ok(calls[0].body.text.length < 4096);
  assert.equal(store.all('SELECT text FROM messages').every(m => m.text === long), true);
});

test('messages arriving during a Telegram edit schedule one follow-up card update', async t => {
  let env, changed = false;
  env = setup(t, url => {
    if (url.endsWith('/editMessageText') && !changed) { changed = true; env.ingest('Another message while editing'); }
    return null;
  });
  env.ingest('Bonjour'); await env.drain(); env.ingest('Merci'); await env.drain();
  assert.equal(env.calls.filter(c => c.url.endsWith('/sendMessage')).length, 1);
  assert.ok(env.calls.at(-1).body.text.includes('Another message while editing'));
});

test('pending legacy text and analysis jobs are absorbed without replaying a message flood', async t => {
  const { store, ingest, integration, calls, drain } = setup(t);
  const { conversation_id: id } = ingest('Bonjour');
  const reply_markup = { inline_keyboard: [[{ text: 'rondivou', callback_data: 'plan:' + id }]] };
  for (const text of ['Instagram · client_name\nHello', '📋 Analyse IA · client_name\nMissing', '👤 Instagram · client_name\nProfil identifié']) store.enqueue('telegram', { text, reply_markup });
  await drain();
  // Legacy jobs were absorbed while the first card was being flushed. Flush the coalesced refresh too.
  await drain();
  assert.equal(calls.filter(c => c.url.endsWith('/sendMessage')).length, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages').n, 1);
});
