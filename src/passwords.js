import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// This record lives on the persistent database volume. Environment credentials
// only bootstrap the first record and never replace a password chosen in the UI.
export function passwords(store, config) {
  if (!store.get('SELECT id FROM admin_credentials WHERE id=1')) {
    const salt = randomBytes(32).toString('hex');
    const hash = scryptSync(config.ADMIN_PASSWORD, salt, 64).toString('hex');
    const required = config.REQUIRE_PASSWORD_CHANGE === 'true' || (config.NODE_ENV === 'production' && config.REQUIRE_PASSWORD_CHANGE !== 'false');
    store.run('INSERT OR IGNORE INTO admin_credentials VALUES(1,?,?,?,?)',salt,hash,Number(required),store.now());
  }
  function verify(value) {
    if (typeof value !== 'string' || value.length > 1024) return false;
    const account = store.get('SELECT salt,password_hash FROM admin_credentials WHERE id=1');
    return timingSafeEqual(scryptSync(value,account.salt,64),Buffer.from(account.password_hash,'hex'));
  }
  function change(current, next) {
    if (!verify(current)) throw Object.assign(new Error('Mot de passe actuel incorrect.'),{status:401});
    if (typeof next !== 'string' || next.length < 16 || next.length > 1024) throw Object.assign(new Error('Choisissez un mot de passe de 16 caractères minimum (1 024 maximum).'),{status:400});
    if (current === next) throw Object.assign(new Error('Le nouveau mot de passe doit être différent de l’ancien.'),{status:400});
    const salt=randomBytes(32).toString('hex');
    const hash=scryptSync(next,salt,64).toString('hex');
    const session=randomBytes(32).toString('hex');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.run('UPDATE admin_credentials SET salt=?,password_hash=?,must_change=0,updated_at=? WHERE id=1',salt,hash,store.now());
      store.run('DELETE FROM sessions');
      store.run('INSERT INTO sessions VALUES(?,?)',session,Date.now()+86400000);
      store.db.exec('COMMIT');
    } catch(e) { store.db.exec('ROLLBACK'); throw e; }
    return session;
  }
  return { verify,change,required:()=>Boolean(store.get('SELECT must_change FROM admin_credentials WHERE id=1').must_change) };
}
