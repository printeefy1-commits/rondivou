import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { integrations } from '../src/integrations.js';
import { createApp } from '../src/app.js';
import { reminderSchedule, isAttendanceConfirmation } from '../src/reminders.js';
const day='2030-06-10', evening='2030-06-09T18:00:00Z', morning='2030-06-10T07:00:00Z';
const settings={TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_ADMIN_ID:'1',META_PAGE_ACCESS_TOKEN:'fixture',META_PAGE_ID:'page',META_INSTAGRAM_ID:'ig'};
function fixture(t,{file=':memory:',channel='messenger',time='15:00',request}={}) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2030-06-08T10:00:00Z')});
  let store=createStore(file);const sent=[];
  const network=request || (async (url,options)=>{sent.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,result:{message_id:1}}));});
  let integration=integrations(store,settings,network);
  const c=store.conversation(channel,'fixture-account','client_account');
  const a=store.book({date:day,time,service:'coiffure',conversation_id:c.id,phone:'0555123456'});store.run('DELETE FROM outbox');
  const at=value=>t.mock.timers.setTime(Date.parse(value));
  const drain=async()=>{for(let i=0;i<30 && store.get('SELECT id FROM outbox WHERE sent_at IS NULL AND next_at<=?',store.now());i++)await integration.flush();};
  const reply=(text='Je confirme',extra={})=>integration.ingest({channel,externalId:c.external_id,username:c.username,messageId:'reply-'+text,text,direction:'in',sentAt:new Date().toISOString(),...extra});
  t.after(()=>store.close());
  return {get store(){return store;},get integration(){return integration;},sent,c,a,at,drain,reply,reopen(){store.close();store=createStore(file);integration=integrations(store,settings,network);}};
}
const meta = f=>f.sent.filter(s=>s.url.includes('graph.facebook.com'));
const telegram = f=>f.sent.filter(s=>s.url.includes('api.telegram.org'));

test('Algeria boundary times and previous-day calendar rollover',()=>{
  for(const time of ['00:00','05:59','06:00','13:00']) assert.deepEqual(reminderSchedule(day+'T'+time+':00+01:00'),[{stage:'evening',dueAt:'2030-06-09T18:00:00.000Z'}]);
  for(const time of ['13:01','18:00'])assert.equal(reminderSchedule(day+'T'+time+':00+01:00')[1].dueAt,'2030-06-10T07:00:00.000Z');
  for(const time of ['18:01','23:59'])assert.deepEqual(reminderSchedule(day+'T'+time+':00+01:00'),[]);
  assert.equal(reminderSchedule('2031-01-01T06:00:00+01:00')[0].dueAt,'2030-12-31T18:00:00.000Z');
  assert.equal(reminderSchedule('2032-03-01T06:00:00+01:00')[0].dueAt,'2032-02-29T18:00:00.000Z');
  for(const yes of ['Je confirme','oui','Oui merci !','نعم'])assert.ok(isAttendanceConfirmation(yes));
  for(const no of ['oui mais pas sûr','je ne confirme pas','oui ?','لا','ok demain ?'])assert.ok(!isAttendanceConfirmation(no));
});

test('afternoon reminders go to client and Telegram at 19:00 and 08:00 only when unconfirmed',async t=>{
  const f=fixture(t);
  f.at('2030-06-09T17:59:59Z');f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,0);
  f.at(evening);f.integration.scheduleReminders();f.integration.scheduleReminders();await f.drain();
  assert.equal(meta(f).length,1);assert.equal(telegram(f).length,1);assert.match(telegram(f)[0].body.text,/FB: client_account/);
  assert.equal(f.store.get('SELECT status FROM appointments').status,'waiting_confirmation');
  assert.equal(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at,null);
  f.at('2030-06-10T06:59:59Z');f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,2);
  f.at(morning);f.integration.scheduleReminders();f.integration.scheduleReminders();await f.drain();
  assert.equal(meta(f).length,2);assert.equal(telegram(f).length,2);assert.match(telegram(f)[1].body.text,/Relance du matin/);
  assert.match(meta(f)[0].body.message.text,/15:00/);assert.equal(meta(f)[0].body.messaging_type,'RESPONSE');
  assert.equal(f.store.all('SELECT * FROM reminder_events').length,2);
  f.at('2030-06-10T08:00:00Z');f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,4);
});

test('Instagram affirmative attendance is saved, alerts the owner and suppresses both morning jobs even if already queued',async t=>{
  const f=fixture(t,{channel:'instagram'});
  f.at(evening);f.integration.scheduleReminders();await f.drain();
  assert.ok(meta(f)[0].url.endsWith('/ig/messages'));assert.equal(meta(f)[0].body.messaging_type,undefined);
  f.at(morning);f.integration.scheduleReminders();
  const result=f.reply('oui');assert.ok(result.attendanceConfirmed);
  const confirmed=f.store.get('SELECT attendance_confirmed_at,status FROM appointments');assert.ok(confirmed.attendance_confirmed_at);assert.equal(confirmed.status,'confirmed');
  await f.drain();assert.equal(meta(f).length,1);
  assert.equal(telegram(f).filter(s=>s.body.text.startsWith('🔔')).length,1);
  assert.ok(telegram(f).some(s=>s.body.text.startsWith('✅ client_account a confirmé')));
});

test('early appointments get only evening alert; start times after 18:00 never alert',async t=>{
  const f=fixture(t,{time:'13:00'});f.at(evening);f.integration.scheduleReminders();await f.drain();
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);assert.equal(telegram(f).length,1);
  const late=f.store.book({date:'2030-06-11',time:'18:01',service:'coiffure',conversation_id:f.c.id});f.store.run('DELETE FROM outbox');
  f.at('2030-06-10T18:00:00Z');f.integration.scheduleReminders();f.at('2030-06-11T07:00:00Z');f.integration.scheduleReminders();await f.drain();
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM reminder_events WHERE appointment_id=?',late.id).n,0);
});

test('cancellations and edits invalidate queued alerts, including service changes at the same time',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();
  f.store.run("UPDATE appointments SET status='cancelled' WHERE id=?",f.a.id);await f.drain();assert.equal(f.sent.length,0);
  f.store.run("UPDATE appointments SET status='confirmed' WHERE id=?",f.a.id);
  const before=f.store.get('SELECT reminder_version FROM appointments').reminder_version;
  f.store.book({date:day,time:'15:00',service:'maquillage',conversation_id:f.c.id},{updateId:f.a.id});
  assert.notEqual(f.store.get('SELECT reminder_version FROM appointments').reminder_version,before);
  f.store.run("DELETE FROM outbox WHERE kind='telegram'");f.at(morning);f.integration.scheduleReminders();await f.drain();
  assert.equal(meta(f).length,1);assert.equal(telegram(f).length,1);
});

test('late bookings get only still-upcoming stages; delayed restart chooses morning rather than sending both',async t=>{
  const f=fixture(t);f.at('2030-06-09T19:00:00Z');
  f.store.run('UPDATE appointments SET created_at=?,reminder_reset_at=?',new Date().toISOString(),new Date().toISOString());
  f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,0);
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);assert.match(telegram(f)[0].body.text,/Relance du matin/);
});

test('persistent reminder stages and attendance survive restarts without duplicate alerts',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'rondivou-reminders-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const f=fixture(t,{file:join(directory,'app.sqlite')});
  f.at(evening);f.integration.scheduleReminders();await f.drain();f.reopen();f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);
  f.at('2030-06-09T18:01:00Z');f.reply();await f.drain();f.reopen();f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);
  assert.ok(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at);
});

test('Meta refusal is surfaced independently of Telegram success and does not invent client confirmation',async t=>{
  const calls=[];const f=fixture(t,{request:async(url,options)=>{calls.push(String(url));return String(url).includes('graph.facebook.com') ? new Response(JSON.stringify({error:{code:10}}),{status:400}) : new Response(JSON.stringify({ok:true,result:{message_id:1}}));}});
  f.at(evening);f.integration.scheduleReminders();await f.drain();
  assert.equal(calls.filter(x=>x.includes('api.telegram.org')).length,1);
  assert.equal(f.store.get("SELECT attempts FROM outbox WHERE kind='meta_reminder'").attempts,1);
  assert.equal(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at,null);
  assert.ok(f.store.get('SELECT telegram_sent_at FROM reminder_events').telegram_sent_at);
  assert.equal(f.store.get('SELECT meta_sent_at FROM reminder_events').meta_sent_at,null);
  f.at(morning);f.integration.scheduleReminders();await f.drain();
  assert.equal(calls.filter(x=>x.includes('api.telegram.org')).length,2);
});

test('website confirmation records attendance and prevents the morning reminder',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();await f.drain();
  const {app}=createApp(f.store,{ADMIN_PASSWORD:'fixture-password-for-reminders'});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-password-for-reminders'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const result=await fetch(base+'/api/appointments/'+f.a.id+'/status',{method:'PATCH',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({status:'confirmed'})});
  assert.equal(result.status,200);assert.ok(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at);
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);assert.equal(telegram(f).length,1);
});

test('late restart expires an unsent evening retry and queues just one morning stage',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();
  f.at(morning);f.integration.scheduleReminders();await f.drain();
  assert.equal(meta(f).length,1);assert.equal(telegram(f).length,1);assert.match(telegram(f)[0].body.text,/Relance du matin/);
  assert.equal(f.store.get("SELECT meta_sent_at FROM reminder_events WHERE stage='evening'").meta_sent_at,null);
});

test('ambiguous, historical, negative or pre-reminder replies do not confirm attendance',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();await f.drain();
  for(const [text,extra] of [['je confirme ?',{}],['oui mais pas sûr',{}],['je confirme',{historical:true}],['je confirme',{sentAt:'2030-06-09T17:00:00Z'}]]) {
    f.reply(text,{messageId:'fixture-'+JSON.stringify(extra)+text,...extra});
    assert.equal(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at,null);
  }
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,2);
});

test('late-day bookings after 08:00 and appointments already started produce no scheduled reminders',async t=>{
  const f=fixture(t);f.at('2030-06-10T07:01:00Z');
  f.store.run('UPDATE appointments SET created_at=?,reminder_reset_at=?',new Date().toISOString(),new Date().toISOString());
  f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,0);
  f.at('2030-06-10T14:00:00Z');f.integration.scheduleReminders();await f.drain();assert.equal(f.sent.length,0);
});

test('changing a phone or note retains attendance and does not re-alert an already confirmed client',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();await f.drain();f.at('2030-06-09T18:01:00Z');f.reply();await f.drain();
  const before=f.store.get('SELECT * FROM appointments');
  const after=f.store.book({date:day,time:'15:00',service:'coiffure',conversation_id:f.c.id,phone:'0555999999',notes:'Nouvelle note'},{updateId:f.a.id});
  assert.equal(after.attendance_confirmed_at,before.attendance_confirmed_at);assert.equal(after.reminder_version,before.reminder_version);
  f.store.run("DELETE FROM outbox WHERE kind='telegram'");f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);
});

test('old 24-hour reminders migrate without replaying delivered alerts and retain existing attendance',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'rondivou-reminder-migration-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'app.sqlite');const f=fixture(t,{file});
  const morningAppointment=f.store.book({date:day,time:'10:00',service:'coiffure',conversation_id:f.c.id});
  f.store.run("UPDATE appointments SET reminder_sent_at=?,status='waiting_confirmation' WHERE id=?",'2030-06-09T15:00:00Z',f.a.id);
  f.store.run("UPDATE appointments SET reminder_sent_at=?,status='confirmed' WHERE id=?",'2030-06-09T15:00:00Z',morningAppointment.id);
  f.store.run('DELETE FROM outbox');
  f.store.enqueue('meta_reminder',{appointmentId:f.a.id,startAt:f.a.start_at});
  f.store.enqueue('telegram',{text:'🔔 Rendez-vous dans 24 h\nAncien rappel'});
  // Simulate the pre-policy on-disk appointment schema with real persisted rows.
  const disk=new DatabaseSync(file);
  for(const column of ['attendance_confirmed_at','reminder_version','reminder_reset_at'])disk.exec('ALTER TABLE appointments DROP COLUMN '+column);
  disk.close();f.reopen();
  assert.equal(f.store.all('SELECT * FROM outbox').length,0);
  assert.equal(f.store.all('SELECT * FROM reminder_events').length,2);
  assert.ok(f.store.get('SELECT attendance_confirmed_at FROM appointments WHERE id=?',morningAppointment.id).attendance_confirmed_at);
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);assert.match(telegram(f)[0].body.text,/Relance du matin/);
});

test('confirmation arriving while the morning API call is in flight is not overwritten by its completion',async t=>{
  let hold=false,release,started;
  const ready=new Promise(r=>{started=r;});const pause=new Promise(r=>{release=r;});
  const f=fixture(t,{request:async(url)=>{if(hold && String(url).includes('graph.facebook.com')){started();await pause;}return new Response(JSON.stringify({ok:true,result:{message_id:1}}));}});
  f.at(evening);f.integration.scheduleReminders();await f.drain();
  hold=true;f.at(morning);f.integration.scheduleReminders();const draining=f.drain();await ready;
  assert.ok(f.reply().attendanceConfirmed);release();await draining;
  const a=f.store.get('SELECT * FROM appointments');assert.equal(a.status,'confirmed');assert.ok(a.attendance_confirmed_at);
});


test('a confirmation may repeat matching appointment details, while conflicting details require review',async t=>{
  const f=fixture(t);f.at(evening);f.integration.scheduleReminders();await f.drain();
  f.at('2030-06-09T18:01:00Z');
  assert.ok(f.reply('Je confirme demain à 16h').needsReview);
  assert.equal(f.store.get('SELECT attendance_confirmed_at FROM appointments').attendance_confirmed_at,null);
  assert.ok(f.reply('Je confirme demain à 15h pour coiffure').attendanceConfirmed);
  f.at(morning);f.integration.scheduleReminders();await f.drain();assert.equal(meta(f).length,1);
});
