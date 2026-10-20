export const SERVICES = [
  { id: 'coiffure', name: 'Coiffure', minutes: 60, color: '#dc947c' },
  { id: 'maquillage', name: 'Maquillage', minutes: 60, color: '#b39ccf' },
  { id: 'coloration', name: 'Coloration', minutes: 180, color: '#b6bc8b' },
  { id: 'lissage', name: 'Lissage', minutes: 180, color: '#8cafb8' },
  { id: 'balayage', name: 'Balayage', minutes: 480, color: '#d6b16a' }
];
export const serviceById = id => SERVICES.find(s => s.id === id);
export function algeriaDate(now = new Date()) { return new Date(now.getTime() + 3600000).toISOString().slice(0, 10); }
export function appointmentTimes(date, time, service) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '') || !serviceById(service)) throw new Error('Date, heure ou prestation invalide.');
  const start = new Date(`${date}T${time}:00+01:00`);
  if (!Number.isFinite(start.getTime()) || algeriaDate(start) !== date) throw new Error('Date invalide.');
  return { start: start.toISOString(), end: new Date(start.getTime() + serviceById(service).minutes * 60000).toISOString() };
}
const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[أإآ]/g, 'ا');
const patterns = {
  coiffure: /\b(coiff(?:ure|es?|age)|brushing|hair\s*style)\b|تصفيف|تسريح|سشوار|بروشينغ/,
  maquillage: /\b(maquillage|make\s*up|makeup)\b|مكياج|ماكياج|ميكاب/,
  coloration: /\b(coloration|couleur|teinture|hair\s*color)\b|صبغ|صبغة|صباغة/,
  lissage: /\b(lissage|keratine|hair\s*lissage)\b|ليساج|كيراتين|فرد الشعر/,
  balayage: /\bbalayage\b|بالياج|بلاياج/
};
export function extract(messages, now = new Date()) {
  const dates = new Set(), times = new Set(), services = new Set();
  for (const message of messages) {
    const t = normalize(message.text);
    const reference = new Date(message.sent_at || now);
    for (const [id, regex] of Object.entries(patterns)) if (regex.test(t)) services.add(id);
    for (const m of t.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) dates.add(`${m[1]}-${m[2]}-${m[3]}`);
    for (const m of t.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](20\d{2}))?\b/g)) dates.add(`${m[3] || algeriaDate(reference).slice(0, 4)}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
    if (/\b(demain|tomorrow)\b|غدوة|غدا/.test(t)) dates.add(algeriaDate(new Date(reference.getTime() + 86400000)));
    if (/\b(aujourd'hui|today)\b|اليوم/.test(t)) dates.add(algeriaDate(reference));
    for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?\b/g)) times.add(`${m[1].padStart(2, '0')}:${m[2] || '00'}`);
    for (const m of t.matchAll(/(?:الساعة|مع|على)\s*([01]?\d|2[0-3])(?:\s*[:h]\s*([0-5]\d))?(?!\d)/g)) {
      let h = Number(m[1]);
      if (/مساء|العشية|العشية/.test(t) && h < 12) h += 12;
      times.add(`${String(h).padStart(2, '0')}:${m[2] || '00'}`);
    }
  }
  const result = { date: dates.size === 1 ? [...dates][0] : '', time: times.size === 1 ? [...times][0] : '', service: services.size === 1 ? [...services][0] : '', ambiguous: dates.size > 1 || times.size > 1 || services.size > 1 };
  try { appointmentTimes(result.date, result.time, result.service); result.complete = !result.ambiguous; } catch { result.complete = false; }
  return result;
}
export function isAgreement(text) {
  const t = normalize(text);
  if (/[?؟]|\b(pas|non|not|ne|sans|peut|pourriez|pouvez)\b|لا |لم |مش|ماناكد|ما ناكد|ما نكد|ما نوكد/.test(t)) return false;
  return /\b(confirme(?:e)?|confirmed|je confirme|c'est confirme|rdv confirme)\b|موعدك موكد|نوكد الموعد|اكد الموعد|متفقين/i.test(t);
}
export function isChange(text) { return /\b(annul\w*|cancel\w*|report\w*|deplac\w*|changer|change|instead)\b|الغاء|نلغي|نبدل|تغيير|نغير|بدل/i.test(normalize(text)); }
