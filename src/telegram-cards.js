import { serviceById } from './domain.js';

// One persistent Telegram message per conversation, with a coalesced delivery job.
export function telegramCards(store, config, telegram, buttons) {
  const enabled = config.TELEGRAM_COMPACT === 'true';
  const clip = (text, limit) => { const chars = Array.from(text); return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text; };
  function queue(conversationId) {
    if (!enabled || !store.get('SELECT id FROM conversations WHERE id=? AND deleted_at IS NULL',conversationId)) return;
    if (!store.get("SELECT id FROM outbox WHERE kind='telegram_card' AND sent_at IS NULL AND json_extract(payload,'$.conversationId')=?", conversationId)) {
      store.enqueue('telegram_card', { conversationId });
      // Wait briefly for profile lookup and nearby messages; never postpone indefinitely.
      store.run("UPDATE outbox SET next_at=? WHERE id=(SELECT id FROM outbox WHERE kind='telegram_card' AND sent_at IS NULL AND json_extract(payload,'$.conversationId')=? ORDER BY rowid DESC LIMIT 1)", new Date(Date.now() + 8000).toISOString(), conversationId);
    }
  }
  function render(conversationId) {
    const c = store.get('SELECT * FROM conversations WHERE id=?', conversationId);
    if (!c || c.deleted_at) return null;
    const messages = store.all('SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,rowid DESC LIMIT 3) ORDER BY sent_at,sequence', c.id);
    const candidate = store.candidate(c.id);
    const context = store.context(c.id);
    const appointment = store.get("SELECT * FROM appointments WHERE conversation_id=? AND status!='cancelled' AND start_at>? ORDER BY start_at LIMIT 1", c.id, store.now());
    const conflict = store.get("SELECT reason FROM reviews WHERE conversation_id=? AND status='pending' ORDER BY created_at DESC,rowid DESC LIMIT 1", c.id)?.reason === 'conflict';
    const date = value => new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
    const lines = [`👤 ${c.channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${clip(c.username, 160)}`];
    if (appointment) lines.push(`${appointment.status === 'waiting_confirmation' ? '⏳ Présence à confirmer' : '✅ Rendez-vous confirmé'} · ${date(appointment.start_at)} · ${serviceById(appointment.service)?.name || appointment.service}`);
    if (context.length) {
      const historical = context.some(m => m.historical);
      const pending = config.AI_BASE_URL && config.AI_API_KEY && candidate.source !== 'ai';
      lines.push('', `📋 ${pending ? 'Analyse en cours' : 'Demande en cours'}`, `Date : ${candidate.date || 'à compléter'} · Heure : ${candidate.time || 'à compléter'}`, `Prestation : ${serviceById(candidate.service)?.name || 'à compléter'}`);
      lines.push(historical ? 'Historique : validation manuelle obligatoire.' : conflict ? '⚠️ Créneau indisponible : vérifiez le calendrier.' : candidate.ambiguous ? 'Informations ambiguës : vérification nécessaire.' : candidate.change_requested ? 'Modification : vérification nécessaire.' : pending ? 'Les résultats apparaîtront dans cette carte.' : candidate.complete ? 'En attente d’accord ou de votre validation.' : 'Informations à compléter si un rendez-vous est demandé.');
    }
    lines.push('', '💬 Derniers échanges');
    for (const m of messages) lines.push(`${m.direction === 'out' ? 'Salon' : 'Cliente'} · ${date(m.sent_at)}${m.historical ? ' · Historique' : ''}\n${clip(m.text, 400)}`);
    lines.push('', 'La conversation complète est conservée sur le site.');
    const markup = buttons(c.id);
    try {
      const url = new URL('/?conversation=' + c.id, config.PUBLIC_URL);
      if (url.protocol === 'https:') markup.inline_keyboard.push([{ text: 'Ouvrir sur le site', url: url.href }]);
    } catch { /* Account buttons remain available without a configured public URL. */ }
    return { text: lines.join('\n'), reply_markup: markup };
  }
  async function deliver(conversationId) {
    const body = render(conversationId);
    if (!body) return;
    const previous = store.get('SELECT * FROM telegram_cards WHERE conversation_id=? AND chat_id=?', conversationId, String(config.TELEGRAM_ADMIN_ID));
    const content = JSON.stringify(body);
    if (previous?.content === content) return;
    let messageId = previous?.message_id;
    if (messageId) {
      try {
        await telegram('editMessageText', { chat_id: config.TELEGRAM_ADMIN_ID, message_id: Number(messageId), ...body });
      } catch (error) {
        if (error.telegramState === 'not_modified') { /* A prior edit may have succeeded before a connection dropped. */ }
        else if (error.telegramState === 'missing_message') messageId = null;
        else throw error; // Never send a duplicate card for a network, rate-limit or auth failure.
      }
    }
    if (!messageId) {
      const sent = await telegram('sendMessage', { chat_id: config.TELEGRAM_ADMIN_ID, ...body });
      if (!Number.isSafeInteger(sent?.message_id)) throw new Error('Identifiant de carte Telegram absent.');
      messageId = String(sent.message_id);
    }
    if (!store.get('SELECT id FROM conversations WHERE id=? AND deleted_at IS NULL',conversationId)) return;
    store.run('INSERT INTO telegram_cards VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,chat_id) DO UPDATE SET message_id=excluded.message_id,content=excluded.content,updated_at=excluded.updated_at', conversationId, String(config.TELEGRAM_ADMIN_ID), String(messageId), content, store.now());
    // If new data arrived during the API request, schedule exactly one follow-up.
    if (JSON.stringify(render(conversationId)) !== content) store.enqueue('telegram_card', { conversationId });
  }
  function absorbLegacy(payload) {
    if (!enabled || !/^(?:📋 Analyse IA · |👤 (?:Instagram|Messenger) · |(?:🗂 Historique · )?(?:Instagram|Messenger) · )/.test(payload.text || '')) return false;
    const callback = payload.reply_markup?.inline_keyboard?.flat().find(b => /^plan:[\w-]+$/.test(b.callback_data || ''));
    if (!callback) return false;
    const id = callback.callback_data.slice(5);
    if (!store.get('SELECT id FROM conversations WHERE id=?', id)) return false;
    queue(id);
    return true;
  }
  return { enabled, queue, render, deliver, absorbLegacy };
}
