import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';

test('conversation search covers usernames, imported and outgoing messages with literal multilingual matching', async t => {
  const store=createStore(':memory:');
  const {app,integration}=createApp(store,{ADMIN_PASSWORD:'fixture-search-password'});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const first=integration.ingest({channel:'instagram',externalId:'one',username:'Élodie_IG',messageId:'one-old',text:'Réservation BALAYAGE 0555123456 مرحبا <b>cliente</b>',direction:'in',historical:true,sentAt:'2026-10-01T09:00:00Z'});
  integration.ingest({channel:'instagram',externalId:'one',username:'Élodie_IG',messageId:'one-new',text:'Merci beaucoup',direction:'in',sentAt:'2026-10-20T09:00:00Z'});
  integration.ingest({channel:'messenger',externalId:'two',username:'Anita',messageId:'two-new',text:'Salon : 100%_unique',direction:'out',sentAt:'2026-10-21T09:00:00Z'});
  assert.equal((await fetch(base+'/api/conversations/search?q=balayage')).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-search-password'})});
  const headers={cookie:login.headers.get('set-cookie').split(';')[0]};
  const search=async query=>(await(await fetch(base+'/api/conversations/search?q='+encodeURIComponent(query),{headers})).json()).conversations;
  for(const query of ['elodie','ÉLODIE','balayage','reservation','0555123456','مرحبا','<b>cliente</b>']) {
    const result=await search(query);assert.equal(result.length,1,query);assert.equal(result[0].id,first.conversation_id);
  }
  const old=(await search('balayage'))[0];
  assert.match(old.match_text,/BALAYAGE/);assert.equal(old.last_text,'Merci beaucoup');
  assert.equal(store.get('SELECT historical FROM messages WHERE id=?',old.match_message_id).historical,1);
  assert.equal((await search('100%_unique'))[0].username,'Anita');
  assert.equal((await search('%')).length,1);
  assert.equal((await search("' OR 1=1 --")).length,0);
  assert.equal((await search('no matching text')).length,0);
  assert.deepEqual(await search('   '),[]);
  const all=await search('a');assert.equal(all.length,2);assert.equal(all[0].username,'Anita');
  assert.equal((await fetch(base+'/api/conversations/search?q='+ 'x'.repeat(201),{headers})).status,400);
  assert.equal((await fetch(base+'/api/conversations/search?q=x&q=y',{headers})).status,400);
});
