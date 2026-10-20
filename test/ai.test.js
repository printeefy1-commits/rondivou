import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, aiEndpoint, validateAnalysis } from '../src/ai.js';
import { createStore } from '../src/store.js';
import { integrations } from '../src/integrations.js';

const config = { AI_BASE_URL: 'https://private-gateway.example/v1', AI_API_KEY: 'test-key-not-real', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_ADMIN_ID: '1' };
const date = '2030-10-23';
const text = 'بغيت بالياج نهار 23 octobre 2030 مع 10 صباح، اسمي سارة';
function evidence(message) { return { message_id: message.id, quote: message.text }; }
function answer(messages, changes = {}) {
  return { date, time: '10:00', service: 'balayage', client_name: 'سارة', phone: '', ambiguous: false, change_requested: false, agreement: false,
    evidence: { date: evidence(messages[0]), time: evidence(messages[0]), service: evidence(messages[0]), client_name: evidence(messages[0]),
      client_agreement: messages[1] && evidence(messages[1]), salon_agreement: messages[2] && evidence(messages[2]) }, ...changes };
}
function setup(t, makeAnswer = m => answer(m), extra = {}) {
  const store = createStore(':memory:'); t.after(() => store.close());
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(options.body);
      const messages = JSON.parse(body.messages[1].content).messages;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(await makeAnswer(messages)) } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const integration = integrations(store, { ...config, ...extra }, request);
  const ingest = (value = text, additions = {}) => integration.ingest({ channel: 'instagram', externalId: 'scope-id', username: 'actual_ig_username', text: value, direction: 'in', messageId: String(calls.length) + value, sentAt: '2030-10-20T08:00:00Z', ...additions });
  const drain = async () => { for (let i = 0; i < 20 && store.get('SELECT id FROM outbox WHERE sent_at IS NULL AND next_at<=?', store.now()); i++) await integration.flush(); };
  return { store, integration, ingest, drain, calls };
}

test('AI extracts mixed text into persistent website candidate without booking a request', async t => {
  const { store, ingest, drain, calls } = setup(t);
  const { conversation_id: id } = ingest();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  await drain();
  assert.equal(store.candidate(id).date, date);
  assert.equal(store.candidate(id).source, 'ai');
  assert.equal(store.candidate(id).client_name, 'سارة');
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?', id).username, 'actual_ig_username');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  const aiCall = calls.find(c => c.url.includes('/chat/completions'));
  assert.equal(aiCall.options.headers.Authorization, 'Bearer test-key-not-real');
  assert.equal(JSON.parse(aiCall.options.body).model, 'auto');
  assert.equal(aiCall.options.redirect, 'error');
  assert.ok(store.all("SELECT payload FROM outbox WHERE kind='telegram'").some(j => JSON.parse(j.payload).text.includes('Analyse IA')));
});

test('AI queues once for concurrent messages and books only bilateral accepted complete data', async t => {
  const { store, ingest, drain, calls } = setup(t, m => answer(m, { agreement: true }));
  const { conversation_id: id } = ingest();
  ingest('Oui je confirme', { messageId: 'accept-client', sentAt: '2030-10-20T08:01:00Z' });
  ingest('Votre rendez-vous est confirmé', { direction: 'out', messageId: 'accept-salon', sentAt: '2030-10-20T08:02:00Z' });
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='ai_extract'").n, 1);
  await drain();
  const a = store.get('SELECT * FROM appointments');
  assert.equal(a.conversation_id, id);
  assert.equal(a.service, 'balayage');
  assert.equal(a.start_at, '2030-10-23T09:00:00.000Z');
  assert.equal(a.end_at, '2030-10-23T17:00:00.000Z');
  assert.equal(a.client_name, 'سارة');
  ingest('Votre rendez-vous est confirmé', { direction: 'out', messageId: 'accept-salon', sentAt: '2030-10-20T08:02:00Z' });
  await drain();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 1);
  assert.equal(calls.filter(c => c.url.includes('/chat/completions')).length, 1);
});

test('AI hallucinated agreement without evidence cannot auto-book', async t => {
  const { store, ingest, drain } = setup(t, m => answer(m, { agreement: true }));
  ingest(); await drain();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
});

test('historical, ambiguous and changed AI candidates always require review', async t => {
  for (const kind of ['historical', 'ambiguous', 'change_requested']) {
    const { store, ingest, drain } = setup(t, m => answer(m, { agreement: true, [kind]: true }));
    ingest(text, { historical: kind === 'historical' });
    ingest('Oui je confirme', { historical: kind === 'historical', messageId: 'accept-client', sentAt: '2030-10-20T08:01:00Z' });
    ingest('Votre rendez-vous est confirmé', { historical: kind === 'historical', direction: 'out', messageId: 'accept-salon', sentAt: '2030-10-20T08:02:00Z' });
    await drain();
    assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0, kind);
  }
});

test('AI cannot override the single-worker availability constraint', async t => {
  const { store, ingest, drain } = setup(t, m => answer(m, { agreement: true }));
  store.book({ date, time: '09:00', service: 'coiffure' });
  store.book({ date, time: '12:00', service: 'coiffure' });
  ingest();
  ingest('Oui je confirme', { messageId: 'accept-client', sentAt: '2030-10-20T08:01:00Z' });
  ingest('Votre rendez-vous est confirmé', { direction: 'out', messageId: 'accept-salon', sentAt: '2030-10-20T08:02:00Z' });
  await drain();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 2);
  assert.equal(store.get("SELECT reason FROM reviews WHERE reason='conflict' LIMIT 1").reason, 'conflict');
});

test('new messages during AI inference discard stale result and schedule a fresh snapshot', async t => {
  let env, first = true;
  env = setup(t, m => {
    if (first) { first = false; env.ingest('Finalement, lissage', { messageId: 'correction', sentAt: '2030-10-20T08:03:00Z' }); }
    return answer(m, { service: first ? 'balayage' : 'lissage', evidence: { ...answer(m).evidence, service: evidence(m.at(-1)) } });
  });
  const { conversation_id: id } = env.ingest();
  await env.integration.flush(); // forward initial text
  await env.integration.flush(); // AI response made stale by correction
  assert.equal(env.store.get('SELECT COUNT(*) AS n FROM ai_analyses').n, 0);
  await env.drain();
  assert.equal(env.store.candidate(id).service, 'lissage');
  assert.equal(env.store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
});

test('manual booking during inference is never duplicated or undone', async t => {
  let env;
  env = setup(t, m => {
    env.store.book({ date, time: '10:00', service: 'balayage', conversation_id: env.store.get('SELECT id FROM conversations').id, source_message_id: m.at(-1).id });
    return answer(m, { agreement: true });
  });
  env.ingest(); await env.drain();
  assert.equal(env.store.get('SELECT COUNT(*) AS n FROM appointments').n, 1);
  assert.equal(env.store.get('SELECT COUNT(*) AS n FROM ai_analyses').n, 0);
});

test('provider errors retry safely without exposing secrets or creating rule-based fallback bookings', async t => {
  const { store, integration, ingest } = setup(t, () => { throw new Error('secret-provider-error-with-key'); });
  ingest('2030-10-23 à 10h balayage, je confirme');
  await integration.flush(); await integration.flush();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n, 0);
  const job = store.get("SELECT * FROM outbox WHERE kind='ai_extract'");
  assert.equal(job.attempts, 1); assert.equal(job.sent_at, null);
  assert.ok(!job.error.includes('secret-provider-error'));
});

test('AI rejects fabricated evidence, invalid dates/services and truncated response', async () => {
  const messages = [{ id: 'm1', text, direction: 'in', sent_at: '2030-10-20T08:00:00Z' }];
  assert.throws(() => validateAnalysis(answer(messages, { service: 'nails' }), messages));
  assert.throws(() => validateAnalysis(answer(messages, { date: '2030-02-31' }), messages));
  assert.throws(() => validateAnalysis(answer(messages, { evidence: {} }), messages));
  assert.throws(() => validateAnalysis(answer(messages, { evidence: { ...answer(messages).evidence, time: { message_id: 'other', quote: text } } }), messages));
  await assert.rejects(analyze(messages, config, async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))), /invalide ou incomplète/);
  await assert.rejects(analyze(messages, config, async () => new Response('{}', { status: 401 })), /HTTP 401/);
});

test('AI URL validation prevents credentials in URLs or insecure remote endpoints', () => {
  assert.equal(aiEndpoint('https://gateway.example/v1/'), 'https://gateway.example/v1/chat/completions');
  assert.throws(() => aiEndpoint('http://gateway.example/v1'));
  assert.throws(() => aiEndpoint('https://secret@gateway.example/v1'));
  assert.throws(() => aiEndpoint('https://gateway.example/v1?key=secret'));
});
