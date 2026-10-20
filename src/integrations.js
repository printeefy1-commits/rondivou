import { randomUUID } from 'node:crypto';
import { extract, isAgreement, isChange } from './domain.js';
import { analyze, aiEnabled, contextKey } from './ai.js';
import { telegramCards } from './telegram-cards.js';

export function integrations(store, config, request = fetch) {
  const graphVersion = config.META_GRAPH_VERSION || 'v23.0';
  async function api(url, options) {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.ok === false || data.error) {
      const error = new Error(`Échec du service distant (${response.status}, code ${data.error?.code || data.error_code || 'inconnu'}).`);
      if (data.error_code === 400 && /^Bad Request: message is not modified\b/i.test(data.description || '')) error.telegramState = 'not_modified';
      if (data.error_code === 400 && /^Bad Request: (message to edit not found|message can't be edited)\b/i.test(data.description || '')) error.telegramState = 'missing_message';
      throw error;
    }
    return data.result ?? data;
  }
  async function telegram(method, body) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_ADMIN_ID) throw new Error('Telegram non configuré.');
    return api(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function graph(path, params = {}, method = 'GET') {
    if (!config.META_PAGE_ACCESS_TOKEN) throw new Error('Meta non configuré.');
    const url = new URL(`https://graph.facebook.com/${graphVersion}/${path}`);
    const options = { method, headers: { Authorization: `Bearer ${config.META_PAGE_ACCESS_TOKEN}` } };
    if (method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(params); }
    return api(url, options);
  }
  function buttons(conversationId) {
    return { inline_keyboard: [[{ text: 'rondivou', callback_data: `plan:${conversationId}` }, { text: 'rondivou confirmé', callback_data: `confirm:${conversationId}` }]] };
  }
  const cards = telegramCards(store, config, telegram, buttons);
  function review(c, message, reason) {
    store.run('INSERT OR IGNORE INTO reviews(id,conversation_id,message_id,reason,created_at) VALUES(?,?,?,?,?)', randomUUID(), c.id, message.id, reason, store.now());
  }
  function queueAnalysis(conversationId) {
    if (!aiEnabled(config) || !store.context(conversationId).length) return;
    if (!store.get("SELECT id FROM outbox WHERE kind='ai_extract' AND sent_at IS NULL AND json_extract(payload,'$.conversationId')=?", conversationId)) store.enqueue('ai_extract', { conversationId });
  }
  function queueMissingProfiles({ retryFailed = false } = {}) {
    if (!config.META_PAGE_ACCESS_TOKEN) return 0;
    let count = 0;
    for (const c of store.all('SELECT id FROM conversations WHERE username=external_id')) {
      const pending = store.get("SELECT id,error FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL AND json_extract(payload,'$.conversationId')=?", c.id);
      if (!pending) {
        store.enqueue('meta_profile', { conversationId: c.id });
        count++;
      } else if (retryFailed && pending.error) {
        store.run('UPDATE outbox SET next_at=?,error=NULL WHERE id=?', store.now(), pending.id);
        count++;
      }
    }
    return count;
  }
  function ingest({ channel, externalId, username, messageId, text, direction, sentAt, historical = false }) {
    if (!text?.trim()) return { ignored: true };
    const c = store.conversation(channel, externalId, username);
    const id = randomUUID();
    const stamp = new Date(sentAt);
    if (!Number.isFinite(stamp.getTime())) throw new Error('Horodatage du message invalide.');
    const inserted = store.run('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)', id, c.id, String(messageId), text.slice(0, 20000), direction, stamp.toISOString(), Number(historical));
    if (!inserted.changes) {
      // Import membership matters for style learning even if a webhook saved the text first.
      // Do not replay forwarding, analysis or booking for a duplicate imported message.
      if (historical) store.run('UPDATE messages SET historical=1 WHERE conversation_id=? AND external_id=?',c.id,String(messageId));
      return { duplicate: true };
    }
    const message = store.get('SELECT * FROM messages WHERE id=?', id);
    if (config.META_PAGE_ACCESS_TOKEN && c.username === c.external_id && !store.get("SELECT id FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL AND json_extract(payload,'$.conversationId')=?", c.id)) {
      store.enqueue('meta_profile', { conversationId: c.id });
    }
    // Every text is forwarded, including the manager's replies, without Telegram HTML parsing.
    const chars = Array.from(text);
    if (cards.enabled) cards.queue(c.id);
    for (let offset = 0; !cards.enabled && offset < chars.length; offset += 2800) {
      store.enqueue('telegram', { text: `${historical ? '🗂 Historique · ' : ''}${channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${c.username}\n${direction === 'out' ? 'Salon' : 'Cliente'} · ${new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', dateStyle: 'short', timeStyle: 'short' }).format(stamp)}${chars.length > 2800 ? ` · partie ${offset / 2800 + 1}` : ''}\n\n${chars.slice(offset, offset + 2800).join('')}`, reply_markup: buttons(c.id) });
    }
    const waiting = store.all("SELECT * FROM appointments WHERE conversation_id=? AND status='waiting_confirmation' AND start_at>? ORDER BY start_at", c.id, store.now());
    if (!historical && direction === 'in' && waiting.length && isAgreement(text) && !isChange(text)) {
      const reply = extract([message]);
      if (waiting.length !== 1 || reply.date || reply.time || reply.service || reply.ambiguous) {
        review(c, message, 'attendance_ambiguous');
        store.enqueue('telegram', { text: `⚠️ Confirmation à vérifier pour ${c.username} : le rendez-vous visé n’est pas certain.`, reply_markup: buttons(c.id) });
        return { conversation_id: c.id, message_id: id, needsReview: true };
      }
      store.run("UPDATE appointments SET status='confirmed',updated_at=? WHERE id=?", store.now(), waiting[0].id);
      store.notify('confirmation', `${c.username} a confirmé sa présence.`);
      store.enqueue('telegram', { text: `✅ ${c.username} a confirmé sa présence.` });
      cards.queue(c.id);
      return { conversation_id: c.id, message_id: id, attendanceConfirmed: true };
    }
    if (aiEnabled(config)) {
      review(c, message, historical ? 'historical' : 'ai_pending');
      queueAnalysis(c.id);
      return { conversation_id: c.id, message_id: id, ai_pending: true };
    }
    const candidate = store.candidate(c.id);
    const changed = store.context(c.id).some(m => isChange(m.text));
    const historicalContext = store.context(c.id).some(m => m.historical);
    if (historical || historicalContext || candidate.ambiguous || changed || !candidate.complete) {
      review(c, message, historical || historicalContext ? 'historical' : changed ? 'change_requested' : candidate.ambiguous ? 'ambiguous' : 'missing_info');
    } else if (isAgreement(text)) {
      try { store.book({ ...candidate, conversation_id: c.id, source_message_id: id }); }
      catch (e) {
        review(c, message, e.status === 409 ? 'conflict' : 'needs_review');
        store.notify('warning', `${c.username} : ${e.message}`);
        store.enqueue('telegram', { text: `⚠️ ${c.username}\n${e.message}`, reply_markup: buttons(c.id) });
      }
    } else review(c, message, 'agreement_needed');
    return { conversation_id: c.id, message_id: id, candidate };
  }
  function metaEvents(body) {
    for (const entry of body.entry || []) {
      const channel = body.object === 'instagram' ? 'instagram' : 'messenger';
      for (const event of entry.messaging || []) {
        if (!event.message?.text || !event.message.mid) continue;
        const ownIds = [config.META_PAGE_ID, config.META_INSTAGRAM_ID, String(entry.id)];
        const outgoing = Boolean(event.message.is_echo) || ownIds.includes(String(event.sender?.id));
        const externalId = outgoing ? event.recipient?.id : event.sender?.id;
        if (!externalId) continue;
        ingest({ channel, externalId: String(externalId), username: String(externalId), messageId: event.message.mid, text: event.message.text, direction: outgoing ? 'out' : 'in', sentAt: event.timestamp || Date.now() });
      }
    }
  }
  async function telegramEvent(body) {
    const callback = body.callback_query;
    const from = callback?.from || body.message?.from;
    const chat = callback?.message?.chat || body.message?.chat;
    if (!from || String(from.id) !== String(config.TELEGRAM_ADMIN_ID) || chat?.type !== 'private' || String(chat.id) !== String(config.TELEGRAM_ADMIN_ID)) return;
    const updateId = String(body.update_id ?? callback?.id ?? body.message?.message_id ?? '');
    if (!updateId || store.get('SELECT id FROM telegram_updates WHERE id=?', updateId)) return;
    if (callback) {
      const match = /^(plan|confirm):([\w-]+)$/.exec(callback.data || '');
      if (!match) return;
      await telegram('answerCallbackQuery', { callback_query_id: callback.id, ...(cards.enabled && match[1] === 'plan' ? { text: 'Utilisez « Ouvrir sur le site » dans la carte pour compléter le formulaire.' } : {}) });
      const c = store.get('SELECT * FROM conversations WHERE id=?', match[2]);
      if (!c) return;
      const candidate = store.candidate(c.id);
      // Explicit preview is mandatory for ambiguous/incomplete data and ALL historical imports.
      const historical = store.context(c.id).some(m => m.historical);
      const changeRequested = store.context(c.id).some(m => isChange(m.text));
      if (aiEnabled(config) && candidate.source !== 'ai') queueAnalysis(c.id);
      if (match[1] === 'confirm' && candidate.complete && !historical && !changeRequested && !candidate.change_requested && (!aiEnabled(config) || candidate.source === 'ai')) {
        const latest = store.context(c.id).at(-1);
        if (!latest) return;
        try { store.book({ ...candidate, conversation_id: c.id, source_message_id: latest.id }); cards.queue(c.id); }
        catch (e) { store.enqueue('telegram', { text: e.message }); }
      } else {
        const url = new URL('/?conversation=' + c.id, config.PUBLIC_URL || 'http://localhost:3000');
        const markup = url.protocol === 'https:' ? { inline_keyboard: [[{ text: 'Ouvrir le formulaire · rondivou', url: url.href }]] } : undefined;
        if (cards.enabled) cards.queue(c.id);
        else store.enqueue('telegram', { text: `📋 ${c.username}\nDate : ${candidate.date || 'à compléter'}\nHeure : ${candidate.time || 'à compléter'}\nPrestation : ${candidate.service || 'à compléter'}\n${historical ? 'Historique : validation manuelle obligatoire.\n' : ''}${changeRequested ? 'Modification ou annulation : vérifiez le rendez-vous existant dans le calendrier.\n' : ''}Ouvrez le formulaire sécurisé du salon pour vérifier et envoyer.${markup ? '' : '\nConfigurez PUBLIC_URL en HTTPS pour activer le lien.'}`, reply_markup: markup });
      }
    } else if (body.message?.text) {
      store.enqueue('telegram', { text: 'Bienvenue dans Rondivou. Les messages du salon apparaîtront ici après connexion de Meta. Utilisez « rondivou » pour ouvrir le formulaire ou « rondivou confirmé » pour valider les informations complètes. Les conversations anciennes nécessitent toujours une vérification.' });
    }
    store.run('INSERT OR IGNORE INTO telegram_updates VALUES(?)', updateId);
  }
  let working = false;
  async function analyzeConversation(conversationId) {
    const c = store.get('SELECT * FROM conversations WHERE id=?', conversationId);
    const messages = store.context(conversationId);
    if (!c || !messages.length || !aiEnabled(config)) return;
    const key = contextKey(messages);
    const result = await analyze(messages, config, request);
    // Messages or manual bookings may arrive while the model is responding.
    // A stale result must never update the form or create a booking.
    if (contextKey(store.context(conversationId)) !== key) {
      if (store.context(conversationId).length) store.enqueue('ai_extract', { conversationId });
      return;
    }
    const previousAnalysis = store.get('SELECT result FROM ai_analyses WHERE conversation_id=?', c.id);
    const previousConflict = store.get("SELECT id FROM reviews WHERE conversation_id=? AND status='pending' AND reason='conflict'", c.id);
    store.run('INSERT INTO ai_analyses VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET context_key=excluded.context_key,result=excluded.result,created_at=excluded.created_at', c.id, key, JSON.stringify(result), store.now());
    const historical = messages.some(m => m.historical);
    const existing = store.get("SELECT id FROM appointments WHERE conversation_id=? AND status!='cancelled' AND start_at>?", c.id, store.now());
    const changed = result.change_requested || messages.some(m => isChange(m.text));
    let reason = historical ? 'historical' : existing || changed ? 'change_requested' : result.ambiguous ? 'ambiguous' : !result.complete ? 'missing_info' : 'agreement_needed';
    if (result.complete && result.agreement && !historical && !existing && !changed) {
      try {
        store.book({ ...result, conversation_id: c.id, source_message_id: messages.at(-1).id });
        cards.queue(c.id);
        return;
      } catch (e) {
        reason = e.status === 409 ? 'conflict' : 'needs_review';
        store.notify('warning', `${c.username} : ${e.message}`);
      }
    }
    store.run("UPDATE reviews SET reason=? WHERE conversation_id=? AND status='pending' AND reason='ai_pending'", reason, c.id);
    if (cards.enabled) {
      cards.queue(c.id);
      const previous = previousAnalysis && JSON.parse(previousAnalysis.result);
      if (reason === 'conflict' && (!previousConflict || previous?.date !== result.date || previous?.time !== result.time || previous?.service !== result.service)) store.enqueue('telegram', { text: `⚠️ ${c.username} : créneau indisponible le ${result.date} à ${result.time}.`, reply_markup: buttons(c.id) });
    } else store.enqueue('telegram', { text: `📋 Analyse IA · ${c.username}\nDate : ${result.date || 'à compléter'}\nHeure : ${result.time || 'à compléter'}\nPrestation : ${result.service || 'à compléter'}\n${historical ? 'Historique : validation manuelle obligatoire.' : reason === 'conflict' ? 'Créneau indisponible : vérification nécessaire.' : existing || changed ? 'Rendez-vous existant ou modification : vérification nécessaire.' : result.ambiguous ? 'Informations ambiguës : vérification nécessaire.' : !result.complete ? 'Informations manquantes : complétez le formulaire.' : 'En attente d’un accord clair ou de votre validation.'}`, reply_markup: buttons(c.id) });
  }
  async function flush() {
    if (working) return;
    working = true;
    try {
      // Resolve identities before slow historical AI work; retries still respect next_at.
      const jobs = store.all("SELECT * FROM outbox WHERE sent_at IS NULL AND next_at<=? ORDER BY CASE WHEN kind='meta_profile' THEN 0 WHEN kind IN ('telegram','telegram_card') THEN 1 ELSE 2 END,rowid LIMIT 1", store.now());
      for (const job of jobs) {
        try {
          const payload = JSON.parse(job.payload);
          if (job.kind === 'telegram' && !cards.absorbLegacy(payload)) await telegram('sendMessage', { chat_id: config.TELEGRAM_ADMIN_ID, ...payload });
          else if (job.kind === 'telegram_card') await cards.deliver(payload.conversationId);
          else if (job.kind === 'ai_extract') await analyzeConversation(payload.conversationId);
          else if (job.kind === 'meta_profile') {
            const c = store.get('SELECT * FROM conversations WHERE id=?', payload.conversationId);
            if (c && c.username === c.external_id) {
              const profile = await graph(c.external_id, { fields: c.channel === 'instagram' ? 'name,username' : 'first_name,last_name' });
              const name = profile.username || profile.name || [profile.first_name, profile.last_name].filter(Boolean).join(' ');
              if (!name?.trim() || name === c.external_id) throw new Error('Meta ne fournit pas encore de nom pour ce compte. Nouvelle tentative programmée.');
              if (name) {
                const updated = store.run('UPDATE conversations SET username=? WHERE id=? AND username=external_id', name, c.id);
                if (updated.changes) {
                  if (cards.enabled) cards.queue(c.id);
                  else store.enqueue('telegram', { text: `👤 ${c.channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${name}\nProfil identifié pour la conversation ${c.external_id}.`, reply_markup: buttons(c.id) });
                }
              }
            }
          }
          else if (job.kind === 'meta_reminder') {
            const a = store.get('SELECT * FROM appointments WHERE id=?', payload.appointmentId);
            if (!a || a.status === 'cancelled' || a.start_at !== payload.startAt || a.reminder_sent_at || new Date(a.start_at) <= new Date()) { store.run('UPDATE outbox SET sent_at=? WHERE id=?', store.now(), job.id); continue; }
            const c = store.get('SELECT * FROM conversations WHERE id=?', a.conversation_id);
            if (!c) throw new Error('Aucune conversation liée au rendez-vous.');
            const text = `Bonjour ! Merci de confirmer votre présence pour votre rendez-vous du ${new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', dateStyle: 'short', timeStyle: 'short' }).format(new Date(a.start_at))} (${a.service}). Répondez à ce message pour confirmer. À bientôt !`;
            await graph(`${c.channel === 'instagram' ? config.META_INSTAGRAM_ID : config.META_PAGE_ID}/messages`, { recipient: { id: c.external_id }, message: { text }, ...(c.channel === 'messenger' ? { messaging_type: 'RESPONSE' } : {}) }, 'POST');
            store.run("UPDATE appointments SET reminder_sent_at=?,status='waiting_confirmation',updated_at=? WHERE id=?", store.now(), store.now(), a.id);
            store.notify('reminder', 'Rappel envoyé : en attente de confirmation de la cliente.');
          }
          store.run('UPDATE outbox SET sent_at=?,error=NULL WHERE id=?', store.now(), job.id);
        } catch (e) {
          const attempts = job.attempts + 1;
          store.run('UPDATE outbox SET attempts=?,next_at=?,error=? WHERE id=?', attempts, new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7))).toISOString(), e.message, job.id);
          if (attempts === 1) store.notify('warning', `${job.kind === 'ai_extract' ? 'Analyse IA' : job.kind === 'meta_profile' ? 'Lecture du profil Meta' : job.kind === 'telegram' ? 'Envoi Telegram' : 'Envoi du rappel Meta'} impossible. Vérifiez la connexion et les permissions dans les paramètres.`);
        }
      }
    } finally { working = false; }
  }
  function scheduleReminders(reference = new Date()) {
    for (const a of store.all("SELECT * FROM appointments WHERE status='confirmed' AND reminder_sent_at IS NULL AND start_at>? AND start_at<=?", reference.toISOString(), new Date(reference.getTime() + 86400000).toISOString())) {
      // Bookings created less than 24 hours before the slot never get reminders.
      if (new Date(a.start_at) - new Date(a.created_at) < 86400000) continue;
      if (a.reminder_queued_start === a.start_at) continue;
      if (store.get("SELECT id FROM outbox WHERE kind='meta_reminder' AND json_extract(payload,'$.appointmentId')=? AND json_extract(payload,'$.startAt')=?", a.id, a.start_at)) continue;
      store.notify('reminder', `Rendez-vous dans 24 h · ${a.client_name || 'Cliente'} · ${a.service}`);
      store.enqueue('telegram', { text: `🔔 Rendez-vous dans 24 h\n${a.client_name || 'Cliente'} · ${a.service}\nLe rappel cliente nécessite une connexion Meta autorisée.` });
      if (a.conversation_id) store.enqueue('meta_reminder', { appointmentId: a.id, startAt: a.start_at });
      else store.notify('warning', 'Rappel cliente impossible : ce rendez-vous manuel ne possède pas de conversation liée.');
      store.run('UPDATE appointments SET reminder_queued_start=? WHERE id=?', a.start_at, a.id);
    }
  }
  async function importHistory() {
    const since = new Date(); since.setUTCMonth(since.getUTCMonth() - 1);
    let imported = 0;
    for (const [channel, platform] of [['messenger', 'messenger'], ['instagram', 'instagram']]) {
      let after;
      do {
        const page = await graph(`${config.META_PAGE_ID}/conversations`, { platform, fields: 'id,participants,updated_time', limit: '100', ...(after ? { after } : {}) });
        for (const conv of page.data || []) {
          if (new Date(conv.updated_time) < since) continue;
          const own = new Set([config.META_PAGE_ID, config.META_INSTAGRAM_ID]);
          const participant = conv.participants?.data?.find(p => !own.has(String(p.id)));
          if (!participant) continue;
          let cursor;
          const texts = [];
          do {
            const messages = await graph(`${conv.id}/messages`, { fields: 'id,message,from,created_time', limit: '100', ...(cursor ? { after: cursor } : {}) });
            let reachedOlder = false;
            for (const m of messages.data || []) {
              if (new Date(m.created_time) < since) { reachedOlder = true; continue; }
              if (m.message) texts.push(m);
            }
            cursor = !reachedOlder && messages.paging?.next ? messages.paging?.cursors?.after : undefined;
          } while (cursor);
          texts.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
          for (const m of texts) {
            const result = ingest({ channel, externalId: String(participant.id), username: participant.username || participant.name || String(participant.id), messageId: m.id, text: m.message, direction: own.has(String(m.from?.id)) ? 'out' : 'in', sentAt: m.created_time, historical: true });
            if (!result.duplicate) imported++;
          }
        }
        after = page.paging?.next ? page.paging?.cursors?.after : undefined;
      } while (after);
    }
    store.notify('import', `${imported} messages importés. Validation manuelle obligatoire avant tout ajout.`);
    return imported;
  }
  return { ingest, metaEvents, telegramEvent, telegram, graph, flush, scheduleReminders, importHistory, queueAnalysis, queueMissingProfiles, refreshCard: cards.queue };
}
