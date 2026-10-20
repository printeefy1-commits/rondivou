import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { integrations } from '../src/integrations.js';
function setup(t, request) {
  const store = createStore(':memory:');t.after(() => store.close());
  const integration = integrations(store, { META_PAGE_ACCESS_TOKEN: 'fixture', TELEGRAM_COMPACT:'true' }, request);
  const c = store.conversation('instagram', '123456789', '123456789');
  return {store, integration, c};
}

test('history participant name resolves an existing ID without duplicating conversation or overwriting a known username', t => {
  const { store, c } = setup(t);
  assert.equal(store.conversation('instagram', c.external_id, 'actual_username').id, c.id);
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?', c.id).username, 'actual_username');
  store.conversation('instagram', c.external_id, c.external_id);
  store.conversation('instagram', c.external_id, 'an older display name');
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?', c.id).username, 'actual_username');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM conversations').n, 1);
});

test('empty Meta profile remains retryable and startup recovery never duplicates a pending job', async t => {
  const { store, integration, c } = setup(t, async () => new Response('{}'));
  assert.equal(integration.queueMissingProfiles(), 1);assert.equal(integration.queueMissingProfiles(), 0);
  await integration.flush();
  const job=store.get("SELECT * FROM outbox WHERE kind='meta_profile'");
  assert.equal(job.attempts,1);assert.equal(job.sent_at,null);
  assert.equal(integration.queueMissingProfiles(),0);
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?',c.id).username,c.external_id);
});

test('startup repairs a previously completed nameless lookup before slow AI jobs', async t => {
  const { store, integration, c } = setup(t, async () => new Response(JSON.stringify({username:'recovered_username'})));
  store.enqueue('meta_profile',{conversationId:c.id});
  store.run('UPDATE outbox SET sent_at=?',store.now());
  store.enqueue('ai_extract',{conversationId:c.id});
  assert.equal(integration.queueMissingProfiles(),1);
  await integration.flush();
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?',c.id).username,'recovered_username');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='ai_extract' AND sent_at IS NULL").n,1);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='telegram'").n,0);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='telegram_card'").n,1);
});

test('a profile arriving late never overwrites a name supplied by import during the request', async t => {
  let env;
  env=setup(t,async()=>{env.store.conversation('instagram',env.c.external_id,'imported_username');return new Response(JSON.stringify({username:'late_profile_name'}));});
  env.integration.queueMissingProfiles();await env.integration.flush();
  assert.equal(env.store.get('SELECT username FROM conversations WHERE id=?',env.c.id).username,'imported_username');
  assert.equal(env.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL").n,0);
});

test('Meta permission failures remain pending and never fabricate or expose profile names', async t => {
  const {store,integration,c}=setup(t,async()=>new Response(JSON.stringify({error:{code:100,message:'PRIVATE_PROVIDER_RESPONSE'}}),{status:400}));
  integration.queueMissingProfiles();await integration.flush();
  const job=store.get("SELECT * FROM outbox WHERE kind='meta_profile'");
  assert.equal(job.sent_at,null);assert.ok(job.error.includes('400'));assert.ok(job.error.includes('100'));
  assert.ok(!job.error.includes('PRIVATE_PROVIDER_RESPONSE'));
  assert.equal(store.get('SELECT username FROM conversations WHERE id=?',c.id).username,c.external_id);
});

test('new live messages can recover an identity even after an old profile job was marked complete', t => {
  const {store,integration,c}=setup(t);
  store.enqueue('meta_profile',{conversationId:c.id});store.run('UPDATE outbox SET sent_at=?',store.now());
  integration.ingest({channel:'instagram',externalId:c.external_id,username:c.external_id,messageId:'new',text:'Bonjour',direction:'in',sentAt:Date.now()});
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL").n,1);
});

test('explicit startup recovery retries failed lookups once without creating duplicate jobs', async t => {
  const {store,integration}=setup(t,async()=>new Response('{}'));
  integration.queueMissingProfiles();await integration.flush();
  assert.equal(integration.queueMissingProfiles({retryFailed:true}),1);
  assert.equal(integration.queueMissingProfiles({retryFailed:true}),0);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL").n,1);
  assert.equal(store.get("SELECT error FROM outbox WHERE kind='meta_profile'").error,null);
});
