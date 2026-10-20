import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { styleLab, redactStyle } from '../src/style-lab.js';
import { createApp } from '../src/app.js';
const config = {AI_BASE_URL:'https://gateway.example/v1',AI_API_KEY:'private-fixture',ADMIN_PASSWORD:'fixture-password'};
function fixture(t, respond) {
  const store = createStore(':memory:'); t.after(()=>store.close());
  const calls=[];
  const request=async (url,options)=>{
    const body=JSON.parse(options.body);const data=JSON.parse(body.messages[1].content);calls.push({url,body,data});
    const output=await respond(data,body);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
  };
  const lab=styleLab(store,config,request);
  const c=store.conversation('instagram','1234567890123','sarah.private');
  let seq=0;
  const add=(text,direction='in',historical=1)=>store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?)','m'+(++seq),c.id,'ext'+seq,text,direction,'2030-10-20T08:'+String(seq%60).padStart(2,'0')+':00Z',historical);
  return {store,lab,c,add,calls,request};
}
const salon = data => ({classification:'salon',rules:['Répond brièvement en darija avec un mot de français.'],examples:data.messages.filter(m=>m.direction==='out').slice(0,1).map(m=>({source_id:m.id,question:'Bonjour, vous faites le balayage ?',answer:m.text}))});

test('learning covers every imported text in bounded chunks and excludes live-only texts', async t=>{
  const {store,lab,add,calls}=fixture(t,salon);
  for(let i=0;i<70;i++)add(i%2?'Oui hbiba 🌷':'Slm balayage ?',i%2?'out':'in');
  add('LIVE MESSAGE MUST NOT BE LEARNED','out',0);
  const id=lab.start();
  assert.equal(store.get('SELECT message_count FROM style_runs WHERE id=?',id).message_count,70);
  for(let i=0;i<5;i++)await lab.tick();
  assert.equal(store.get('SELECT status FROM style_runs WHERE id=?',id).status,'completed');
  assert.equal(calls.flatMap(c=>c.data.messages).length,70);
  assert.ok(calls.every(c=>c.data.messages.length<=30 && JSON.stringify(c.data).length<20000));
  assert.ok(!JSON.stringify(calls).includes('LIVE MESSAGE MUST NOT BE LEARNED'));
  assert.ok(calls.every(c=>c.url==='https://gateway.example/v1/chat/completions'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n,0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n,0);
});

test('redaction removes known identities, contacts and numeric historical prices before model calls',async t=>{
  const {lab,add,calls}=fixture(t,salon);
  add('sarah.private sarah +213 555 123 456 contact@test.invalid https://private.invalid prix 6000 DA');
  add('Bienvenue hbiba','out');lab.start();await lab.tick();
  const sent=JSON.stringify(calls[0].data);
  for(const secret of ['sarah.private','sarah','555','6000','contact@test.invalid','private.invalid'])assert.ok(!sent.includes(secret),secret);
  assert.ok(redactStyle('اسمي سارة، هاتفي ٠٥٥٥١٢٣٤٥٦').includes('[nom]'));
});

test('personal, mixed and uncertain chunks never supply style examples even if model offers them',async t=>{
  for(const type of ['personal','mixed','uncertain']){
    const {store,lab,add}=fixture(t,data=>({...salon(data),classification:type}));
    add('Je veux acheter un sac');add('Je peux payer à la livraison ?','out');lab.start();await lab.tick();
    const chunk=JSON.parse(store.get('SELECT result FROM style_chunks').result);
    assert.equal(chunk.examples.length,0);assert.equal(chunk.rules.length,0);
    await assert.rejects(lab.test('Slm'),/Aucun exemple/);
  }
});

test('invented or incoming-only examples are skipped without becoming learned style',async t=>{
  const {store,lab,add}=fixture(t,data=>({classification:'salon',rules:[],examples:[{source_id:data.messages[0].id,question:'Slm',answer:data.messages[0].text}]}));
  add('Message cliente');lab.start();await lab.tick();
  assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
  assert.equal(store.get('SELECT status FROM style_chunks').status,'skipped');
});

test('old prices are excluded from examples; price tests defer to a human without invoking model',async t=>{
  const {lab,store,add,calls}=fixture(t,data=>({...salon(data),examples:data.messages.filter(m=>m.direction==='out').map(m=>({question:'Quel tarif ?',answer:m.text,source_id:m.id}))}));
  add('Balayage ?');add('Le tarif est 6000 DA','out');add('Oui hbiba','out');lab.start();await lab.tick();
  assert.equal(JSON.parse(store.get('SELECT result FROM style_chunks').result).examples.length,0);
  const before=calls.length;const answer=await lab.test('Ch7al le prix balayage ?');
  assert.equal(answer.needs_human,1);assert.ok(!answer.reply.includes('6000'));assert.equal(calls.length,before);
});

test('private tests use learned style and corrected/approved feedback without sending or booking',async t=>{
  const {store,lab,add,calls}=fixture(t,data=>data.messages?salon(data):{reply:'Slm hbiba 🌷 wach habiti diri ?',needs_human:false});
  add('Slm');add('Slm hbiba 🌷','out');lab.start();await lab.tick();
  const first=await lab.test('Bonjour je veux un brushing');
  store.run("UPDATE style_tests SET feedback='corrected',correction=? WHERE id=?",'Bienvenue hbiba, wach habiti ?',first.id);
  await lab.test('Slm je veux un brushing');
  assert.ok(calls.at(-1).data.examples.some(e=>e.answer==='Bienvenue hbiba, wach habiti ?'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n,0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n,0);
});

test('sandbox rejects model-generated numbers or monetary amounts',async t=>{
  const {lab,add}=fixture(t,data=>data.messages?salon(data):{reply:'Oui le forfait est à 9000 DA',needs_human:false});
  add('Slm');add('Slm hbiba','out');lab.start();await lab.tick();
  const answer=await lab.test('Quels services proposez-vous ?');
  assert.equal(answer.needs_human,1);assert.ok(!answer.reply.includes('9000'));
});

test('paused jobs resume from persisted pending batches without repeating completed ones',async t=>{
  const {store,lab,add,calls,request}=fixture(t,salon);
  for(let i=0;i<40;i++)add('Bonjour balayage ?',i%2?'out':'in');
  const id=lab.start();await lab.tick();store.run("UPDATE style_runs SET status='paused' WHERE id=?",id);
  await lab.tick();assert.equal(calls.length,1);
  store.run("UPDATE style_runs SET status='running' WHERE id=?",id);
  const restarted=styleLab(store,config,request);await restarted.tick();
  assert.equal(calls.length,2);assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
});

test('manual exclusion during inference wins and no excluded rule is retained',async t=>{
  let env;
  env=fixture(t,data=>{env.store.run("UPDATE style_chunks SET status='excluded',result=NULL");return salon(data);});
  env.add('Slm');env.add('Bienvenue hbiba','out');env.lab.start();await env.lab.tick();
  assert.equal(env.store.get('SELECT status FROM style_chunks').status,'excluded');
  await assert.rejects(env.lab.test('Bonjour'),/Aucun exemple/);
});

test('lab routes require salon authentication and feedback is stored only as local test data',async t=>{
  const store=createStore(':memory:');const {app}=createApp(store,config);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/api/style')).status,401);
  store.run('INSERT INTO sessions VALUES(?,?)','abcdef',Date.now()+60000);
  const headers={cookie:'rondivou_session=abcdef','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/style',{headers})).status,200);
  assert.equal((await fetch(base+'/api/style/learn',{headers,method:'POST',body:'{}'})).status,409);
  store.run("INSERT INTO style_runs VALUES('r',?,1,1,'completed',NULL)",store.now());
  store.run("INSERT INTO style_tests VALUES('t','r','test','hello',0,'','',?)",store.now());
  const response=await fetch(base+'/api/style/tests/t/feedback',{headers,method:'POST',body:JSON.stringify({feedback:'corrected',correction:'Contact 0555123456'})});
  assert.equal(response.status,200);assert.ok(!store.get("SELECT correction FROM style_tests WHERE id='t'").correction.includes('0555123456'));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n,0);
});

test('long imported texts are split without silently losing any source content',async t=>{
  const {lab,store,add,calls}=fixture(t,()=>({classification:'uncertain',rules:[],examples:[]}));
  const text='Texte de contexte sans montant. '.repeat(1200);add(text);
  lab.start();for(let i=0;i<10;i++)await lab.tick();
  assert.equal(store.get('SELECT message_count FROM style_runs').message_count,1);
  assert.equal(calls.flatMap(c=>c.data.messages).map(m=>m.text).join(''),redactStyle(text));
  assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
});

test('a stored learning snapshot resumes after closing and reopening the database',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const folder=mkdtempSync(join(tmpdir(),'rondivou-style-'));const file=join(folder,'style.sqlite');
  let store=createStore(file);const c=store.conversation('instagram','client','name');
  for(let i=0;i<40;i++)store.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?)','m'+i,c.id,'e'+i,'Bonjour balayage',i%2?'out':'in','2030-10-20T08:00:00Z',1);
  let count=0;
  const request=async(_url,options)=>{count++;const data=JSON.parse(JSON.parse(options.body).messages[1].content);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(salon(data))}}]}));};
  const lab=styleLab(store,config,request);lab.start();await lab.tick();store.close();
  store=createStore(file);t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  const next=styleLab(store,config,request);await next.tick();
  assert.equal(count,2);assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
});

test('re-imported webhook texts join the learning corpus without duplicate messages or forwarding',async t=>{
  const {store,lab,c,request}=fixture(t,salon);const {integrations}=await import('../src/integrations.js');
  const integration=integrations(store,{},request);
  const message={channel:'instagram',externalId:c.external_id,username:c.username,messageId:'same',text:'Bonjour balayage ?',direction:'in',sentAt:Date.now()};
  integration.ingest(message);const count=store.get('SELECT COUNT(*) AS n FROM outbox').n;
  integration.ingest({...message,historical:true});
  assert.equal(store.get('SELECT COUNT(*) AS n FROM messages').n,1);
  assert.equal(store.get('SELECT historical FROM messages').historical,1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n,count);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM appointments').n,0);
  lab.start();assert.equal(store.get('SELECT message_count FROM style_runs').message_count,1);
});

test('an invalid style batch is skipped and later batches continue automatically',async t=>{
  let n=0;
  const {store,lab,add}=fixture(t,data=>++n===1?{classification:'salon',rules:[{invalid:'object'}],examples:[]}:salon(data));
  for(let i=0;i<40;i++)add('Slm hbiba',i%2?'out':'in');
  lab.start();await lab.tick();
  assert.equal(store.get("SELECT COUNT(*) AS n FROM style_chunks WHERE status='skipped'").n,1);
  assert.equal(store.get('SELECT status FROM style_runs').status,'running');
  await lab.tick();
  assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
  assert.equal(store.get("SELECT COUNT(*) AS n FROM style_chunks WHERE status='done'").n,1);
  assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
});

test('upgrading an old stopped run keeps finished batches and skips the failed unclear batch',async t=>{
  const {store,lab,add,request,calls}=fixture(t,salon);
  for(let i=0;i<65;i++)add('Bonjour balayage ?',i%2?'out':'in');
  lab.start();await lab.tick();
  const failed=store.get("SELECT id FROM style_chunks WHERE status='pending' ORDER BY rowid LIMIT 1");
  store.run("UPDATE style_chunks SET status='failed',result=? WHERE id=?",JSON.stringify({error:'Observation de style invalide.'}),failed.id);
  store.run("UPDATE style_runs SET status='failed',error='Observation de style invalide.'");
  const next=styleLab(store,config,request);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM style_chunks WHERE status='done'").n,1);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM style_chunks WHERE status='skipped'").n,1);
  await next.tick();
  assert.equal(calls.length,2);
  assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
});

test('provider failure waits then retries the same pending batch without skipping any messages',async t=>{
  const {store,add}=fixture(t,salon);
  add('Slm');add('Slm hbiba','out');
  let count=0;
  const request=async(_url,options)=>{
    count++;
    if(count===1)return new Response('{}',{status:429});
    const data=JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(salon(data))}}]}));
  };
  const lab=styleLab(store,config,request);lab.start();await lab.tick();
  assert.equal(store.get('SELECT status FROM style_chunks').status,'pending');
  assert.equal(store.get('SELECT status FROM style_runs').status,'queued');
  assert.ok(lab.report().run.retry_at);await lab.tick();assert.equal(count,1);
  store.run("UPDATE style_retries SET next_at='2000-01-01T00:00:00Z'");await lab.tick();
  assert.equal(count,2);assert.equal(store.get('SELECT status FROM style_runs').status,'completed');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM style_retries').n,0);
});

test('a legacy failed network request becomes pending instead of being skipped during upgrade',t=>{
  const {store,lab,add,request}=fixture(t,salon);add('Bonjour');lab.start();
  store.run("UPDATE style_chunks SET status='failed',result=?",JSON.stringify({error:'Service IA indisponible (HTTP 401).'}));
  store.run("UPDATE style_runs SET status='failed'");styleLab(store,config,request);
  assert.equal(store.get('SELECT status FROM style_chunks').status,'pending');
  assert.equal(store.get('SELECT status FROM style_runs').status,'queued');
});
