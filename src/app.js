import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { SERVICES } from './domain.js';
import { integrations } from './integrations.js';
import { aiEnabled } from './ai.js';

export function createApp(store, config, request, audit = record => console.info(JSON.stringify(record))) {
  const app = express();
  app.disable('x-powered-by');
  const integration = integrations(store, config, request);
  const passwordHash = scryptSync(config.ADMIN_PASSWORD, 'rondivou-admin', 64);
  const failures = new Map();
  let importRunning = false;
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/webhooks/meta', (req, res) => {
    if (config.META_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.META_VERIFY_TOKEN) return res.type('text').send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  app.post('/webhooks/meta', (req, res, next) => {
    // Structural counts only: no body, URL query, identity, signature or token is logged.
    res.locals.metaAudit = { event: 'meta_webhook', reason: 'not_processed' };
    res.on('finish', () => {
      try { audit({ ...res.locals.metaAudit, status: res.statusCode, at: new Date().toISOString() }); } catch { /* Logging must not interrupt delivery. */ }
    });
    next();
  }, express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    const info = res.locals.metaAudit;
    if (!config.META_APP_SECRET) { info.reason = 'secret_not_configured'; return res.sendStatus(503); }
    if (!Buffer.isBuffer(req.body)) { info.reason = 'unsupported_content_type'; return res.sendStatus(400); }
    const signature = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + createHmac('sha256', config.META_APP_SECRET).update(req.body || '').digest('hex');
    if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { info.reason = 'invalid_signature'; return res.sendStatus(403); }
    let body;
    try { body = JSON.parse(req.body.toString()); }
    catch { info.reason = 'invalid_json'; return res.sendStatus(400); }
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const events = entries.flatMap(entry => Array.isArray(entry?.messaging) ? entry.messaging : []);
    const changes = entries.flatMap(entry => Array.isArray(entry?.changes) ? entry.changes : []);
    const known = new Set(['messages', 'message_echoes', 'messaging_postbacks', 'messaging_seen', 'messaging_reactions', 'feed', 'comments']);
    Object.assign(info, { object: ['page', 'instagram'].includes(body?.object) ? body.object : 'other', entries: entries.length,
      messaging_events: events.length, text_events: events.filter(event => typeof event?.message?.text === 'string').length,
      echo_events: events.filter(event => event?.message?.is_echo === true).length,
      changes_fields: [...new Set(changes.map(change => known.has(change?.field) ? change.field : 'other'))] });
    try { integration.metaEvents(body); info.reason = 'accepted'; res.sendStatus(200); }
    catch { info.reason = 'event_processing_failed'; res.status(400).json({ error: 'Événement invalide.' }); }
  });
  app.post('/webhooks/telegram', express.json({ limit: '1mb' }), async (req, res) => {
    const expected = config.TELEGRAM_WEBHOOK_SECRET || '';
    const secret = req.get('x-telegram-bot-api-secret-token') || '';
    if (!expected || secret.length !== expected.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) return res.sendStatus(403);
    try { await integration.telegramEvent(req.body); res.sendStatus(200); }
    catch { res.status(502).json({ error: 'Telegram temporairement indisponible.' }); }
  });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const allowed = new URL(config.PUBLIC_URL || 'http://localhost:3000').origin;
      const localOrigins = [`http://localhost:${config.PORT || 3000}`, `http://127.0.0.1:${config.PORT || 3000}`];
      if (origin && origin !== allowed && !(!config.PUBLIC_URL && localOrigins.includes(origin))) return res.status(403).json({ error: 'Origine non autorisée.' });
      if (req.get('sec-fetch-site') === 'cross-site') return res.sendStatus(403);
    }
    next();
  });
  const sessionId = req => /(?:^|;\s*)rondivou_session=([a-f0-9]+)/.exec(req.get('cookie') || '')?.[1];
  app.get('/api/session', (req, res) => res.json({ authenticated: Boolean(store.get('SELECT id FROM sessions WHERE id=? AND expires_at>?', sessionId(req) || '', Date.now())) }));
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const failure = failures.get(key);
    if (failure?.count >= 5 && failure.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    const value = typeof req.body.password === 'string' ? req.body.password.slice(0, 1024) : '';
    if (!timingSafeEqual(scryptSync(value, 'rondivou-admin', 64), passwordHash)) {
      failures.set(key, { count: (failure?.until > Date.now() ? failure.count : 0) + 1, until: Date.now() + 900000 });
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    failures.delete(key);
    store.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    const id = randomBytes(32).toString('hex');
    store.run('INSERT INTO sessions VALUES(?,?)', id, Date.now() + 86400000);
    res.set('Set-Cookie', `rondivou_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${config.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (!store.get('SELECT id FROM sessions WHERE id=? AND expires_at>?', sessionId(req) || '', Date.now())) return res.status(401).json({ error: 'Connexion requise.' });
    next();
  });
  app.post('/api/logout', (req, res) => { store.run('DELETE FROM sessions WHERE id=?', sessionId(req)); res.set('Set-Cookie', 'rondivou_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true }); });
  app.get('/api/dashboard', (_req, res) => {
    const conversations = store.all(`SELECT c.*, (SELECT text FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC,rowid DESC LIMIT 1) AS last_text,
      (SELECT COUNT(*) FROM reviews WHERE conversation_id=c.id AND status='pending') AS review_count,
      (SELECT sent_at FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC,rowid DESC LIMIT 1) AS last_at FROM conversations c ORDER BY last_at DESC`);
    res.json({ services: SERVICES, appointments: store.all('SELECT a.*,c.username,c.channel FROM appointments a LEFT JOIN conversations c ON c.id=a.conversation_id ORDER BY start_at'), conversations,
      notifications: store.all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50'),
      connections: { telegram: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ADMIN_ID && config.TELEGRAM_WEBHOOK_SECRET), meta: Boolean(config.META_APP_SECRET && config.META_VERIFY_TOKEN && config.META_PAGE_ACCESS_TOKEN && config.META_PAGE_ID && config.META_INSTAGRAM_ID), publicUrl: Boolean(config.PUBLIC_URL?.startsWith('https://')) },
      delivery: store.all('SELECT kind,COUNT(*) AS count FROM outbox WHERE sent_at IS NULL AND error IS NOT NULL GROUP BY kind'), importRunning });
  });
  app.get('/api/conversations/:id', (req, res) => {
    const c = store.get('SELECT * FROM conversations WHERE id=?', req.params.id);
    if (!c) return res.sendStatus(404);
    const candidate = store.candidate(c.id);
    res.json({ ...c, messages: store.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY sent_at,rowid', c.id), candidate: { ...candidate, ai_pending: aiEnabled(config) && candidate.source !== 'ai' && store.context(c.id).length > 0 }, reviews: store.all("SELECT * FROM reviews WHERE conversation_id=? AND status='pending'", c.id) });
  });
  app.post('/api/conversations/:id/analyze', (req, res) => {
    if (!aiEnabled(config)) return res.status(409).json({ error: 'Configurez la connexion IA sur le serveur.' });
    if (!store.get('SELECT id FROM conversations WHERE id=?', req.params.id)) return res.sendStatus(404);
    integration.queueAnalysis(req.params.id);
    res.json({ queued: true });
  });
  app.post('/api/conversations/:id/dismiss', (req, res) => { store.run("UPDATE reviews SET status='dismissed' WHERE conversation_id=?", req.params.id); res.json({ ok: true }); });
  function validateBooking(body) {
    const input = {};
    for (const key of ['date', 'time', 'service', 'client_name', 'phone', 'notes', 'conversation_id', 'source_message_id']) {
      if (body[key] != null && typeof body[key] !== 'string') throw Object.assign(new Error('Données invalides.'), { status: 400 });
      input[key] = body[key]?.trim().slice(0, key === 'notes' ? 4000 : 300) || '';
    }
    if (input.conversation_id && !store.get('SELECT id FROM conversations WHERE id=?', input.conversation_id)) throw Object.assign(new Error('Conversation introuvable.'), { status: 400 });
    if (input.source_message_id && !store.get('SELECT id FROM messages WHERE id=? AND conversation_id=?', input.source_message_id, input.conversation_id)) throw Object.assign(new Error('Message source invalide.'), { status: 400 });
    return input;
  }
  app.post('/api/appointments', (req, res, next) => { try { res.status(201).json(store.book(validateBooking(req.body))); } catch (e) { next(e); } });
  app.put('/api/appointments/:id', (req, res, next) => { try { res.json(store.book(validateBooking(req.body), { updateId: req.params.id })); } catch (e) { next(e); } });
  app.patch('/api/appointments/:id/status', (req, res) => {
    if (!['cancelled', 'confirmed', 'waiting_confirmation'].includes(req.body.status)) return res.sendStatus(400);
    const a = store.get('SELECT * FROM appointments WHERE id=?', req.params.id);
    if (!a) return res.sendStatus(404);
    if (a.status === 'cancelled' && req.body.status !== 'cancelled') {
      const conflict = store.get("SELECT id FROM appointments WHERE id!=? AND status!='cancelled' AND start_at<? AND end_at>?", a.id, a.end_at, a.start_at);
      if (conflict) return res.status(409).json({ error: 'Impossible de rétablir ce rendez-vous : créneau occupé.' });
    }
    store.run('UPDATE appointments SET status=?,updated_at=? WHERE id=?', req.body.status, store.now(), req.params.id);
    store.notify('status', `Statut du rendez-vous mis à jour : ${req.body.status}`);
    res.json({ ok: true });
  });
  app.post('/api/notifications/read', (_req, res) => { store.run('UPDATE notifications SET read_at=? WHERE read_at IS NULL', store.now()); res.json({ ok: true }); });
  app.post('/api/integrations/telegram/connect', async (_req, res, next) => {
    try {
      if (!config.PUBLIC_URL?.startsWith('https://') || !config.TELEGRAM_WEBHOOK_SECRET || !/^\d+$/.test(config.TELEGRAM_ADMIN_ID || '')) throw Object.assign(new Error('Configurez PUBLIC_URL en HTTPS, TELEGRAM_ADMIN_ID et TELEGRAM_WEBHOOK_SECRET.'), { status: 400 });
      await integration.telegram('setWebhook', { url: new URL('/webhooks/telegram', config.PUBLIC_URL).href, secret_token: config.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      await integration.telegram('sendMessage', { chat_id: config.TELEGRAM_ADMIN_ID, text: '✅ Rondivou est connecté. Ce compte est le seul autorisé à gérer les rendez-vous.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post('/api/integrations/meta/subscribe', async (_req, res, next) => {
    try { await integration.graph(`${config.META_PAGE_ID}/subscribed_apps`, { subscribed_fields: 'messages,message_echoes' }, 'POST'); res.json({ ok: true, note: 'Vérifiez aussi les abonnements Instagram dans le tableau de bord Meta.' }); } catch (e) { next(e); }
  });
  app.post('/api/integrations/meta/import', (_req, res) => {
    if (importRunning) return res.status(409).json({ error: 'Un import est déjà en cours.' });
    if (!config.META_PAGE_ACCESS_TOKEN || !config.META_PAGE_ID) return res.status(400).json({ error: 'Configurez la connexion Meta avant l’import.' });
    importRunning = true;
    integration.importHistory().catch(e => store.notify('warning', `Import interrompu : ${e.message} Les messages déjà importés sont conservés. Vous pouvez relancer sans doublons.`)).finally(() => { importRunning = false; });
    res.status(202).json({ ok: true });
  });
  app.use(express.static(resolve(import.meta.dirname, '../public')));
  app.use((err, _req, res, _next) => res.status(err.status || 400).json({ error: err.status || !err.code ? err.message : 'Opération impossible. Vérifiez les données.' }));
  return { app, integration };
}
