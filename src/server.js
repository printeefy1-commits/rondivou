import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createStore } from './store.js';
import { createApp } from './app.js';
const config = { ...process.env };
if (config.NODE_ENV === 'production') {
  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD.length < 16) throw new Error('Production : configurez ADMIN_PASSWORD avec au moins 16 caractères.');
  if (!config.PUBLIC_URL?.startsWith('https://')) throw new Error('Production : configurez PUBLIC_URL avec votre adresse HTTPS publique.');
  if (config.COOKIE_SECURE !== 'true') throw new Error('Production : COOKIE_SECURE doit être true.');
}
if (!config.ADMIN_PASSWORD) {
  mkdirSync('.data', { recursive: true, mode: 0o700 });
  const path = '.data/admin-password';
  if (!existsSync(path)) writeFileSync(path, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
  config.ADMIN_PASSWORD = readFileSync(path, 'utf8').trim();
  console.log('Mot de passe administrateur local : fichier .data/admin-password (non suivi par Git).');
}
const store = createStore(config.DATABASE_PATH || '.data/rondivou.sqlite');
const { app, integration } = createApp(store, config);
integration.queueMissingProfiles({ retryFailed: true });
const server = app.listen(Number(config.PORT || 3000), config.HOST || '127.0.0.1', () => console.log('Rondivou démarré · fuseau Africa/Algiers · port ' + (config.PORT || 3000)));
const timer = setInterval(() => { integration.scheduleReminders(); integration.flush().catch(() => store.notify('warning', 'Erreur du traitement des notifications.')); }, 1000);
timer.unref();
function stop() { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
