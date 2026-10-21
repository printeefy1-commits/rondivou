import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';
const original='fixture-old-password-123';
const chosen='fixture-new-private-password-456';
async function serve(store, extra={}) {
  const {app,integration}=createApp(store,{ADMIN_PASSWORD:original,REQUIRE_PASSWORD_CHANGE:'true',...extra});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const login=async password=>fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  return {base,login,integration,close:()=>new Promise(r=>server.close(r))};
}
const cookie = response=>response.headers.get('set-cookie')?.split(';')[0];
const jsonHeaders = session=>({'Content-Type':'application/json',cookie:session});

test('first login requires a password change; new credential persists and revokes previous sessions',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'rondivou-auth-'));const file=join(dir,'app.sqlite');
  let store=createStore(file);let site=await serve(store);
  let closed=false;t.after(async()=>{if(!closed){await site.close();store.close();}rmSync(dir,{recursive:true,force:true});});
  const login=await site.login(original);const session=cookie(login);
  assert.equal((await login.json()).passwordChangeRequired,true);
  const other=await site.login(original);const otherSession=cookie(other);
  const gated=await fetch(site.base+'/api/dashboard',{headers:{cookie:session}});
  assert.equal(gated.status,403);assert.equal((await gated.json()).code,'password_change_required');
  const bad=await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:'wrong',newPassword:chosen})});
  assert.equal(bad.status,400);
  const short=await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:original,newPassword:'short'})});assert.equal(short.status,400);
  const same=await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:original,newPassword:original})});assert.equal(same.status,400);
  const changed=await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:original,newPassword:chosen})});
  assert.equal(changed.status,200);const newSession=cookie(changed);
  assert.notEqual(newSession,session);assert.equal((await changed.json()).passwordChangeRequired,false);
  assert.equal((await fetch(site.base+'/api/dashboard',{headers:{cookie:newSession}})).status,200);
  assert.equal((await fetch(site.base+'/api/dashboard',{headers:{cookie:otherSession}})).status,401);
  assert.equal((await site.login(original)).status,401);
  assert.equal((await site.login(chosen)).status,200);
  const account=store.get('SELECT * FROM admin_credentials');assert.ok(!JSON.stringify(account).includes(chosen));assert.equal(account.password_hash.length,128);
  await site.close();store.close();
  store=createStore(file);site=await serve(store,{ADMIN_PASSWORD:'different-env-password-must-not-reset'});
  const after=await site.login(chosen);assert.equal(after.status,200);assert.equal((await after.json()).passwordChangeRequired,false);
  assert.equal((await site.login(original)).status,401);
  assert.equal((await site.login('different-env-password-must-not-reset')).status,401);
  await site.close();store.close();closed=true;
  assert.ok(!readFileSync(file).includes(Buffer.from(chosen)));
});

test('password changes require authentication and same-origin requests',async t=>{
  const store=createStore(':memory:');const site=await serve(store);t.after(async()=>{await site.close();store.close();});
  assert.equal((await fetch(site.base+'/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const session=cookie(await site.login(original));
  assert.equal((await fetch(site.base+'/api/password',{method:'POST',headers:{...jsonHeaders(session),origin:'https://outside.invalid'},body:JSON.stringify({currentPassword:original,newPassword:chosen})})).status,403);
  for(let i=0;i<5;i++)await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:'wrong',newPassword:chosen})});
  assert.equal((await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:original,newPassword:chosen})})).status,429);
});

test('forced password setup does not block Meta callbacks or alter appointment data',async t=>{
  const store=createStore(':memory:');const site=await serve(store,{META_VERIFY_TOKEN:'fixture-verify'});t.after(async()=>{await site.close();store.close();});
  const response=await fetch(site.base+'/webhooks/meta?hub.mode=subscribe&hub.verify_token=fixture-verify&hub.challenge=test');
  assert.equal(response.status,200);assert.equal(await response.text(),'test');
  const c=store.conversation('instagram','fixture-user','fixture_name');
  store.book({date:'2030-10-25',time:'10:00',service:'coiffure',phone:'0555123456',conversation_id:c.id});
  const session=cookie(await site.login(original));
  const changed=await fetch(site.base+'/api/password',{method:'POST',headers:jsonHeaders(session),body:JSON.stringify({currentPassword:original,newPassword:chosen})});
  const data=await(await fetch(site.base+'/api/dashboard',{headers:{cookie:cookie(changed)}})).json();
  assert.equal(data.appointments[0].phone,'0555123456');assert.equal(data.appointments[0].username,'fixture_name');
  assert.equal((await fetch(site.base+'/api/style',{headers:{cookie:cookie(changed)}})).status,404);
  assert.ok(!readFileSync(new URL('../public/index.html',import.meta.url),'utf8').includes('Laboratoire IA'));
  assert.ok(!readFileSync(new URL('../src/server.js',import.meta.url),'utf8').includes('learning.tick'));
});
