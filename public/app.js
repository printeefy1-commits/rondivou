const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDate = date => new Date(new Date(date).getTime() + 3600000).toISOString().slice(0, 10);
const today = () => localDate(new Date());
const format = (date, opts) => new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', ...opts }).format(new Date(date));
const clock = date => format(date, { hour: '2-digit', minute: '2-digit', hour12: false });
const addDays = (date, n) => new Date(new Date(`${date}T12:00:00+01:00`).getTime() + n * 86400000).toISOString().slice(0, 10);
let conversationQuery = '', conversationResults = [], searchTimer, searchVersion = 0;
let state, selectedDate = today(), mode = window.innerWidth < 760 ? 'day' : 'week', currentView = 'calendar', currentConversation, toastTimeout;
const service = id => state?.services.find(s => s.id === id);
const statusLabel = status => ({ confirmed: 'Confirmé', waiting_confirmation: 'Attente de confirmation', cancelled: 'Annulé' }[status] || status);
const calendarAccount = a => {
  const prefix = a.channel === 'instagram' ? 'IG' : a.channel === 'messenger' ? 'FB' : '';
  return prefix ? `${prefix}: ${a.username || 'Compte non renseigné'}` : a.client_name || a.username || 'Cliente';
};
function toast(text) { clearTimeout(toastTimeout); $('#toast').textContent = text; $('#toast').hidden = false; toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    if (data.code === 'password_change_required') showPasswordChange();
    throw new Error(data.error || 'Une erreur est survenue. Veuillez réessayer.');
  }
  return data;
}
function showLogin() { $('#shell').hidden = true; $('#password-change').hidden = true; $('#login').hidden = false; }
function showPasswordChange() { $('#shell').hidden = true; $('#login').hidden = true; $('#password-change').hidden = false; $('#password-change-error').textContent = ''; }
function switchView(view) {
  currentView = view;
  for (const key of ['calendar', 'messages', 'settings']) $(`#${key}-view`).hidden = key !== view;
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#breadcrumb').textContent = { calendar: 'Calendrier', messages: 'Conversations', settings: 'Connexions' }[view];
}
async function refresh() {
  state = await api('/dashboard');
  $('#shell').hidden = false; $('#login').hidden = true; $('#password-change').hidden = true;
  render();
  if (conversationQuery) searchConversations();
}
function render() {
  $('#stat-today').textContent = state.appointments.filter(a => a.status !== 'cancelled' && localDate(a.start_at) === today()).length;
  $('#stat-waiting').textContent = state.appointments.filter(a => a.status === 'waiting_confirmation').length;
  const reviews = state.conversations.filter(c => c.review_count > 0);
  $('#stat-review').textContent = reviews.length;
  $('#nav-count').textContent = reviews.length;
  const unread = state.notifications.filter(n => !n.read_at).length;
  $('#notification-count').hidden = !unread;
  $('#legend').innerHTML = state.services.map(s => `<span><i data-color="${s.id}"></i>${escape(s.name)}</span>`).join('');
  $$('[data-color]').forEach(e => { e.style.backgroundColor = service(e.dataset.color).color; });
  $('select[name=service]').innerHTML = '<option value="">Choisir une prestation</option>' + state.services.map(s => `<option value="${s.id}">${escape(s.name)} · ${s.minutes / 60} h</option>`).join('');
  renderCalendar(); renderFollow(); renderConversationList(); renderSettings(); renderNotifications();
}
function renderCalendar() {
  const hourHeight = 120;
  const dayOfWeek = new Date(`${selectedDate}T12:00:00+01:00`).getUTCDay();
  const start = mode === 'day' ? selectedDate : addDays(selectedDate, -((dayOfWeek + 6) % 7));
  const dates = Array.from({ length: mode === 'day' ? 1 : 7 }, (_, i) => addDays(start, i));
  $('#calendar-title').textContent = format(`${selectedDate}T12:00:00+01:00`, { month: 'long', year: 'numeric' });
  $('#day-view').classList.toggle('selected', mode === 'day'); $('#week-view').classList.toggle('selected', mode === 'week');
  const visible = state.appointments.filter(a => a.status !== 'cancelled' && localDate(a.start_at) <= dates.at(-1) && localDate(a.end_at) >= dates[0]);
  let first = 8, last = 19;
  for (const a of visible) {
    if (dates.includes(localDate(a.start_at))) first = Math.min(first, Number(clock(a.start_at).slice(0, 2)));
    if (dates.includes(localDate(a.end_at))) last = Math.max(last, Math.ceil(Number(clock(a.end_at).slice(0, 2)) + Number(clock(a.end_at).slice(3)) / 60));
    if (localDate(a.start_at) !== localDate(a.end_at)) { first = 0; last = 24; }
  }
  const calendar = $('#calendar');
  calendar.style.setProperty('--days', dates.length);
  calendar.style.setProperty('--min-width', mode === 'week' ? '840px' : '0px');
  calendar.style.setProperty('--height', `${(last - first) * hourHeight}px`);
  calendar.innerHTML = `<div class="calendar-head"><div></div>${dates.map(d => `<div class="day-heading ${d === today() ? 'today' : ''}"><small>${escape(format(`${d}T12:00:00+01:00`, { weekday: 'short' }))}</small><strong>${Number(d.slice(-2))}</strong></div>`).join('')}</div><div class="calendar-grid"><div class="time-axis">${Array.from({ length: last - first }, (_, i) => `<span class="hour-label" data-hour="${i}">${String(first + i).padStart(2, '0')}:00</span>`).join('')}</div>${dates.map(d => `<div class="day-column ${d === today() ? 'is-today' : ''}" data-date="${d}">${Array.from({ length: last - first }, (_, i) => `<button class="slot-button" data-hour="${i}" data-time="${String(first + i).padStart(2, '0')}:00" aria-label="Ajouter un rendez-vous le ${d} à ${first + i} heures"></button>`).join('')}</div>`).join('')}</div>`;
  $$('[data-hour]', calendar).forEach(e => e.style.setProperty('--hour', e.dataset.hour));
  $$('.slot-button', calendar).forEach(b => b.onclick = () => openBooking({ date: b.parentElement.dataset.date, time: b.dataset.time }));
  for (const d of dates) {
    const dayStart = new Date(`${d}T00:00:00+01:00`).getTime(), dayEnd = dayStart + 86400000;
    for (const a of visible.filter(a => new Date(a.start_at).getTime() < dayEnd && new Date(a.end_at).getTime() > dayStart)) {
      const s = service(a.service), from = Math.max(dayStart, new Date(a.start_at).getTime()), to = Math.min(dayEnd, new Date(a.end_at).getTime());
      const button = document.createElement('button'); button.className = 'appointment';
      button.style.setProperty('--top', `${((from - dayStart) / 60000 - first * 60) * hourHeight / 60}px`);
      button.style.setProperty('--size', `${Math.max(28, (to - from) / 60000 * hourHeight / 60 - 4)}px`);
      button.style.setProperty('--accent', s.color); button.style.setProperty('--tint', `${s.color}23`);
      button.innerHTML = `<time>${escape(clock(a.start_at))} — ${escape(clock(a.end_at))}</time><strong>${escape(s.name)}</strong><small>${escape(calendarAccount(a))}</small>${a.phone ? `<small class="appointment-phone" dir="ltr">Tél. ${escape(a.phone)}</small>` : ''}${a.status === 'waiting_confirmation' ? '<i class="waiting-dot"></i>' : ''}`;
      button.title = `${s.name} · ${calendarAccount(a)}${a.phone ? ` · Tél. ${a.phone}` : ''} · ${statusLabel(a.status)}`;
      button.onclick = () => showAppointment(a);
      $(`[data-date="${d}"]`, calendar).append(button);
    }
  }
}
function renderFollow() {
  const pending = state.conversations.filter(c => c.review_count > 0).slice(0, 3);
  const waiting = state.appointments.filter(a => a.status === 'waiting_confirmation').slice(0, 2);
  $('#follow-count').textContent = pending.length + waiting.length;
  $('#follow-list').innerHTML = pending.map(c => `<button class="follow-item" data-conversation="${c.id}"><div class="follow-top"><span class="avatar">${escape(c.username.slice(0, 2).toUpperCase())}</span><strong>${escape(c.username)}</strong></div><span class="tag lavender">Informations à vérifier</span><p>${escape(c.last_text)}</p><div class="follow-action"><span>Voir la conversation</span><span>↗</span></div></button>`).join('') + waiting.map(a => `<button class="follow-item" data-appointment="${a.id}"><div class="follow-top"><span class="avatar">${escape((a.client_name || a.username || 'C').slice(0, 2).toUpperCase())}</span><strong>${escape(a.client_name || a.username || 'Cliente')}</strong></div><span class="tag">Confirmation attendue</span><p>${escape(service(a.service).name)} · ${escape(format(a.start_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</p><div class="follow-action"><span>Consulter le rendez-vous</span><span>↗</span></div></button>`).join('');
  if (!pending.length && !waiting.length) $('#follow-list').innerHTML = '<div class="empty-follow"><strong>Tout est à jour ✧</strong>Les conversations à vérifier et les confirmations attendues apparaîtront ici.</div>';
  $$('[data-conversation]', $('#follow-list')).forEach(b => b.onclick = () => { switchView('messages'); openConversation(b.dataset.conversation); });
  $$('[data-appointment]', $('#follow-list')).forEach(b => b.onclick = () => showAppointment(state.appointments.find(a => a.id === b.dataset.appointment)));
}
function renderConversationList() {
  const conversations = conversationQuery ? conversationResults : state.conversations;
  $('#conversation-list').innerHTML = conversations.length ? conversations.map(c => `<button class="conversation-card ${currentConversation === c.id ? 'selected' : ''}" data-id="${c.id}" data-match-id="${escape(c.match_message_id || '')}"><div class="conversation-card-top"><strong>${escape(c.username)}</strong><span class="channel-badge ${c.channel === 'instagram' ? 'instagram' : 'facebook'}">${c.channel === 'instagram' ? 'IG' : 'FB'}</span></div><small>${c.review_count ? '<span class="review-dot"></span> À vérifier · ' : ''}Dernier échange : ${escape(c.last_at ? format(c.last_at, { dateStyle: 'short', timeStyle: 'short', hour12: false }) : '—')}</small><small class="conversation-start" title="Date du premier message disponible dans Rondivou">Début : ${escape(format(c.started_at || c.created_at, { dateStyle: 'short', timeStyle: 'short', hour12: false }))}</small><p>${c.match_text ? '<span class="search-match-label">Message correspondant</span>' : ''}${escape(c.match_text || c.last_text)}</p></button>`).join('') : conversationQuery ? '<div class="empty-state"><h3>Aucune conversation trouvée.</h3><p>Essayez un autre nom ou d’autres mots.</p></div>' : '<div class="empty-state"><span>↗</span><h3>Votre prochain échange arrive bientôt.</h3><p>Connectez Meta pour recevoir vos conversations.</p><button id="empty-connect" class="outline">Configurer les connexions</button></div>';
  $$('.conversation-card').forEach(b => b.onclick = () => openConversation(b.dataset.id,b.dataset.matchId));
  if ($('#empty-connect')) $('#empty-connect').onclick = () => switchView('settings');
}
async function searchConversations() {
  const version = ++searchVersion, query = conversationQuery;
  if (!query) { conversationResults = []; renderConversationList(); return; }
  $('#conversation-search-status').textContent = 'Recherche en cours…';
  try {
    const result = await api('/conversations/search?q=' + encodeURIComponent(query));
    if (version !== searchVersion) return;
    conversationResults = result.conversations;
    renderConversationList();
    $('#conversation-search-status').textContent = `${conversationResults.length} conversation${conversationResults.length === 1 ? '' : 's'} trouvée${conversationResults.length === 1 ? '' : 's'}.`;
  } catch(e) {
    if (version === searchVersion) $('#conversation-search-status').textContent = e.message;
  }
}
$('#conversation-search').oninput = () => {
  clearTimeout(searchTimer); ++searchVersion;
  conversationQuery = $('#conversation-search').value.trim(); conversationResults = [];
  $('#clear-conversation-search').hidden = !$('#conversation-search').value;
  $('#conversation-search-status').textContent = conversationQuery ? 'Recherche en cours…' : 'Recherche dans tous les messages, y compris l’historique importé.';
  if (!conversationQuery) renderConversationList();
  else searchTimer = setTimeout(searchConversations,250);
};
$('#clear-conversation-search').onclick = () => {
  $('#conversation-search').value = ''; $('#conversation-search').oninput(); $('#conversation-search').focus();
};
async function openConversation(id, matchId) {
  try {
    const changingConversation = currentConversation !== id;
    const previousList = !changingConversation && $('.message-list');
    const previousScroll = previousList ? previousList.scrollTop : 0;
    const followLatest = !previousList || previousList.scrollHeight - previousList.clientHeight - previousScroll < 40;
    currentConversation = id; renderConversationList();
    const c = await api('/conversations/' + id);
    if (currentConversation !== id) return;
    const candidate = c.candidate;
    const historical = c.reviews.some(r => r.reason === 'historical');
    const latest = c.messages.at(-1);
    $('#conversation-detail').innerHTML = `<div class="conversation-header"><div><h2>${escape(c.username)}</h2><small>${c.channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${c.messages.length} messages</small><small class="conversation-start">Début des échanges disponibles : ${escape(format(c.started_at || c.messages[0]?.sent_at || c.created_at, { dateStyle: 'long', timeStyle: 'short', hour12: false }))}</small><span class="message-order">↓ Derniers messages en bas</span></div><div class="conversation-actions"><button class="outline small" id="dismiss-review">Marquer comme traité</button><button class="outline small danger" id="delete-conversation">Supprimer la conversation</button></div></div><div class="message-list">${c.messages.map(m => `<div data-message-id="${escape(m.id)}" class="message ${m.id === matchId ? 'search-match ' : ''}${m.direction === 'out' ? 'out' : ''}" dir="auto"><small>${m.direction === 'out' ? 'Salon' : 'Cliente'} · ${escape(format(m.sent_at, { dateStyle: 'short', timeStyle: 'short', hour12: false }))}${m.historical ? ' · Historique' : ''}</small>${escape(m.text)}</div>`).join('')}</div><div class="candidate-panel"><div class="candidate-values"><span>◷ ${escape(candidate.date || 'Date manquante')}</span><span>${escape(candidate.time || 'Heure manquante')}</span><span>${escape(service(candidate.service)?.name || 'Prestation manquante')}</span></div><p>${candidate.ai_pending ? 'Analyse IA en attente. Vous pouvez compléter le formulaire manuellement.' : historical ? 'Historique : vérifiez le contexte et la date avant de créer un rendez-vous.' : candidate.ambiguous ? 'Plusieurs informations possibles : sélectionnez les bonnes valeurs dans le formulaire.' : 'Vérifiez les informations avant de confirmer le rendez-vous.'}</p><div class="candidate-actions">${candidate.source === 'ai' || candidate.ai_pending ? '<button class="outline" id="analyze-conversation">Analyser avec IA</button>' : ''}<button class="primary" id="plan-conversation">rondivou ↗</button><button class="outline" id="confirm-conversation">rondivou confirmé</button></div></div>`;
    if ($('#analyze-conversation')) $('#analyze-conversation').onclick = async () => { try { await api(`/conversations/${id}/analyze`, { method: 'POST', body: '{}' }); toast('Analyse IA programmée.'); } catch (e) { toast(e.message); } };
    const plan = () => openBooking({ ...candidate, channel: c.channel, username: c.username, conversation_id: c.id, source_message_id: latest?.id || '', context: `${c.channel === 'instagram' ? 'Instagram' : 'Messenger'} · ${c.username}${historical ? ' · Import historique : validation manuelle' : ''}` });
    $('#plan-conversation').onclick = plan; $('#confirm-conversation').onclick = plan;
    $('#delete-conversation').onclick = async event => {
      if (!confirm(`Supprimer la conversation avec ${c.username} ?\n\nSes messages seront supprimés de Rondivou. Les rendez-vous et leurs coordonnées seront conservés. Facebook, Instagram et les messages Telegram déjà reçus ne seront pas supprimés.\n\nUn nouveau message fera réapparaître ce compte avec une conversation vide de cet ancien historique.`)) return;
      event.target.disabled=true;
      try {
        await api('/conversations/'+encodeURIComponent(id),{method:'DELETE'});
        ++searchVersion;
        const wasSelected=currentConversation === id;
        if (wasSelected) currentConversation=null;
        state.conversations=state.conversations.filter(item=>item.id !== id);
        conversationResults=conversationResults.filter(item=>item.id !== id);
        if (wasSelected) $('#conversation-detail').innerHTML='<div class="empty-state"><h3>Conversation supprimée.</h3><p>Les rendez-vous restent disponibles dans le calendrier.</p></div>';
        renderConversationList(); await refresh(); toast('Conversation supprimée. Rendez-vous conservés.');
      } catch(e) { event.target.disabled=false; toast(e.message); }
    };
    $('#dismiss-review').onclick = async () => { try { await api(`/conversations/${id}/dismiss`, { method: 'POST', body: '{}' }); await refresh(); toast('Conversation marquée comme traitée.'); } catch (e) { toast(e.message); } };
    const messageList = $('.message-list');
    messageList.scrollTop = followLatest ? messageList.scrollHeight : previousScroll;
    if (matchId) $$('.message',messageList).find(m => m.dataset.messageId === matchId)?.scrollIntoView({block:'center'});
    if (changingConversation && window.innerWidth <= 760) $('#conversation-detail').scrollIntoView({ block: 'start' });
  } catch (e) { toast(e.message); }
}
function renderSettings() {
  for (const name of ['telegram', 'meta']) { const el = $(`#${name}-status`), good = state.connections[name]; el.textContent = good ? 'Paramètres présents · À tester' : 'À configurer'; el.classList.toggle('good', good); }
  $('#import-history').disabled = state.importRunning; $('#import-history').textContent = state.importRunning ? 'Import en cours…' : 'Importer le dernier mois';
  $('#delivery-errors').innerHTML = state.delivery.map(d => `<div class="delivery-error">${d.count} envoi(s) ${d.kind === 'telegram' ? 'Telegram' : 'de rappel Meta'} en attente après un échec. Les nouvelles tentatives sont automatiques ; vérifiez vos accès et les règles du service.</div>`).join('');
}
function renderNotifications() {
  $('#notifications-list').innerHTML = state.notifications.length ? state.notifications.map(n => `<div class="notification ${n.read_at ? '' : 'unread'}">${escape(n.text)}<small>${escape(format(n.created_at, { dateStyle: 'short', timeStyle: 'short' }))}</small></div>`).join('') : '<p class="panel-description">Aucune notification pour le moment.</p>';
}
function openBooking(values = {}) {
  const form = $('#booking-form'); form.reset(); $('#booking-error').textContent = '';
  const channel = values.channel === 'instagram' ? 'IG' : values.channel === 'messenger' ? 'FB' : '';
  const account = channel && values.username ? ` pour ${values.username} (${channel})` : '';
  $('#booking-title').textContent = values.id ? `Modifier le rendez-vous${account}` : `Nouveau rendez-vous${account}`;
  $('#booking-context').textContent = values.context || '';
  for (const key of ['id', 'conversation_id', 'source_message_id', 'date', 'time', 'service', 'client_name', 'phone', 'notes']) form.elements[key].value = values[key] || (key === 'date' ? selectedDate : '');
  durationHint(); $('#booking-dialog').showModal();
}
function durationHint() { const s = service($('#booking-form').elements.service.value); $('#duration-hint').textContent = s ? `Durée prévue : ${s.minutes / 60} h · Une seule professionnelle, aucun chevauchement.` : 'Sélectionnez une prestation pour voir sa durée.'; }
function showAppointment(a) {
  $('#appointment-detail').innerHTML = `<div class="detail-wrap"><header class="dialog-header"><div><p class="eyebrow">LE RENDEZ-VOUS EN DÉTAIL</p><h2>${escape(service(a.service).name)}</h2></div><button class="icon-button" id="close-appointment" aria-label="Fermer">×</button></header><span class="tag">${escape(statusLabel(a.status))}</span><div class="detail-list"><div><span>Cliente</span><strong>${escape(a.client_name || a.username || 'Non renseignée')}</strong></div><div><span>Téléphone</span><strong>${escape(a.phone || 'Non renseigné')}</strong></div><div><span>Date</span><strong>${escape(format(a.start_at, { dateStyle: 'long' }))}</strong></div><div><span>Horaire · Algérie</span><strong>${escape(clock(a.start_at))} — ${escape(clock(a.end_at))} · ${service(a.service).minutes / 60} h</strong></div><div><span>Origine</span><strong>${escape(a.channel === 'instagram' ? 'Instagram' : a.channel === 'messenger' ? 'Messenger' : 'Saisie manuelle')}</strong></div></div><p class="detail-note">${escape(a.notes)}</p><div class="detail-actions"><button class="primary" id="edit-appointment">Modifier ↗</button>${a.status !== 'cancelled' ? '<button class="outline danger" id="cancel-appointment">Annuler le rendez-vous</button>' : ''}${a.status === 'waiting_confirmation' ? '<button class="outline" id="confirm-attendance">Confirmer la présence</button>' : ''}</div></div>`;
  $('#appointment-dialog').showModal(); $('#close-appointment').onclick = () => $('#appointment-dialog').close();
  $('#edit-appointment').onclick = () => { $('#appointment-dialog').close(); openBooking({ ...a, date: localDate(a.start_at), time: clock(a.start_at) }); };
  if ($('#cancel-appointment')) $('#cancel-appointment').onclick = async () => {
    if (!confirm('Annuler ce rendez-vous ? Cette action libère le créneau.')) return;
    try { await api(`/appointments/${a.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }); $('#appointment-dialog').close(); await refresh(); toast('Rendez-vous annulé.'); } catch (e) { toast(e.message); }
  };
  if ($('#confirm-attendance')) $('#confirm-attendance').onclick = async () => { try { await api(`/appointments/${a.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) }); $('#appointment-dialog').close(); await refresh(); toast('Présence confirmée.'); } catch (e) { toast(e.message); } };
}
$('#login-form').onsubmit = async event => { event.preventDefault(); const button = $('button[type=submit]', event.target); button.disabled = true; try { const session = await api('/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; $('#login-error').textContent = ''; if (session.passwordChangeRequired) showPasswordChange(); else { await refresh(); await openDeepLink(); } } catch (e) { $('#login-error').textContent = e.message; } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/logout', { method: 'POST', body: '{}' }); showLogin(); } catch (e) { toast(e.message); } };
$$('[data-view]').forEach(b => b.onclick = () => switchView(b.dataset.view));
$('#connections-shortcut').onclick = () => switchView('settings');
$$('.new-booking').forEach(b => b.onclick = () => openBooking());
$$('.close-dialog').forEach(b => b.onclick = () => $('#booking-dialog').close());
$('#booking-form').elements.service.onchange = durationHint;
$('#booking-form').onsubmit = async event => {
  event.preventDefault(); const button = $('button[type=submit]', event.target); button.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(event.target));
    await api(input.id ? '/appointments/' + input.id : '/appointments', { method: input.id ? 'PUT' : 'POST', body: JSON.stringify(input) });
    selectedDate = input.date; $('#booking-dialog').close(); await refresh();
    if (currentConversation && currentView === 'messages') await openConversation(currentConversation);
    toast('Le rendez-vous est confirmé.');
  } catch (e) { $('#booking-error').textContent = e.message; } finally { button.disabled = false; }
};
$('#prev-date').onclick = () => { selectedDate = addDays(selectedDate, mode === 'day' ? -1 : -7); renderCalendar(); };
$('#next-date').onclick = () => { selectedDate = addDays(selectedDate, mode === 'day' ? 1 : 7); renderCalendar(); };
$('#today').onclick = () => { selectedDate = today(); renderCalendar(); };
$('#day-view').onclick = () => { mode = 'day'; renderCalendar(); }; $('#week-view').onclick = () => { mode = 'week'; renderCalendar(); };
$('#refresh-messages').onclick = () => refresh().then(() => currentConversation && openConversation(currentConversation)).catch(e => toast(e.message));
$('#notification-toggle').onclick = () => { $('#notifications-panel').hidden = !$('#notifications-panel').hidden; };
$('#close-notifications').onclick = () => { $('#notifications-panel').hidden = true; };
$('#read-notifications').onclick = async () => { try { await api('/notifications/read', { method: 'POST', body: '{}' }); await refresh(); } catch (e) { toast(e.message); } };
for (const [selector, endpoint, message] of [['#connect-telegram', '/integrations/telegram/connect', 'Telegram est connecté. Un message de test a été envoyé.'], ['#connect-meta', '/integrations/meta/subscribe', 'Page abonnée. Vérifiez également la configuration Instagram dans Meta.'], ['#import-history', '/integrations/meta/import', 'Import démarré. Les messages accessibles du dernier mois seront soumis à votre vérification.']]) {
  $(selector).onclick = async event => { const button = event.currentTarget; if (selector === '#import-history' && !confirm('Importer les messages du dernier mois et les transmettre à votre compte Telegram privé ? Aucun rendez-vous historique ne sera créé automatiquement.')) return; button.disabled = true; try { await api(endpoint, { method: 'POST', body: '{}' }); toast(message); await refresh(); } catch (e) { toast(e.message); } finally { button.disabled = false; } };
}
async function openDeepLink() {
  const id = new URLSearchParams(location.search).get('conversation');
  if (id) {
    switchView('messages'); await openConversation(id);
    const c = await api('/conversations/' + encodeURIComponent(id));
    openBooking({ ...c.candidate, channel: c.channel, username: c.username, conversation_id: c.id, source_message_id: c.messages.at(-1)?.id || '', context: c.username + ' · Vérifiez les informations avant envoi.' });
    history.replaceState({}, '', '/');
  }
}
(async () => { try { const session = await api('/session'); if (session.authenticated) { if (session.passwordChangeRequired) showPasswordChange(); else { await refresh(); await openDeepLink(); } } else showLogin(); } catch (e) { showLogin(); $('#login-error').textContent = e.message; } })();
setInterval(async () => {
  if ($('#shell').hidden || document.hidden || $('dialog[open]')) return;
  try { await refresh(); if (currentView === 'messages' && currentConversation) await openConversation(currentConversation); } catch { /* Existing state remains visible; manual refresh provides error details. */ }
}, 30000);


$('#change-password').onclick = showPasswordChange;
$('#password-change-logout').onclick = async () => { try { await api('/logout', {method:'POST',body:'{}'}); $('#password-change-form').reset(); showLogin(); } catch(e) { $('#password-change-error').textContent=e.message; } };
$('#password-change-form').onsubmit = async event => {
  event.preventDefault(); const b=$('button[type=submit]',event.target); b.disabled=true; $('#password-change-error').textContent='';
  try {
    if ($('#new-password').value !== $('#confirm-new-password').value) throw new Error('Les deux nouveaux mots de passe ne correspondent pas.');
    await api('/password',{method:'POST',body:JSON.stringify({currentPassword:$('#current-password').value,newPassword:$('#new-password').value})});
    event.target.reset(); await refresh(); await openDeepLink(); toast('Votre nouveau mot de passe est enregistré.');
  } catch(e) { $('#password-change-error').textContent=e.message; } finally { b.disabled=false; }
};
