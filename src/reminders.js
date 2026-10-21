import { isAgreement } from './domain.js';

// Salon policy: Africa/Algiers is UTC+1 year-round. Start times determine the group.
export function reminderSchedule(startAt) {
  const start = new Date(startAt);
  if (!Number.isFinite(start.getTime())) return [];
  const local = new Date(start.getTime() + 3600000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minute > 18 * 60) return [];
  const day = local.toISOString().slice(0,10);
  const previousDay = new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
  const events = [{stage:'evening',dueAt:new Date(previousDay+'T19:00:00+01:00').toISOString()}];
  if (minute > 13 * 60) events.push({stage:'morning',dueAt:new Date(day+'T08:00:00+01:00').toISOString()});
  return events;
}

export function eligibleReminder(a, stage, reference = new Date()) {
  if (!a || a.status === 'cancelled' || a.attendance_confirmed_at || new Date(a.start_at) <= reference) return false;
  const schedule = reminderSchedule(a.start_at);
  const current = schedule.find(event => event.stage === stage);
  if (!current || new Date(current.dueAt) > reference || (new Date(a.created_at) > new Date(current.dueAt) || new Date(a.reminder_reset_at || a.created_at) > new Date(current.dueAt))) return false;
  // After the morning slot opens, never send both stages during a late restart.
  if (stage === 'evening' && schedule.some(event => event.stage === 'morning' && new Date(event.dueAt) <= reference)) return false;
  return true;
}

// Only used for the reply to an attendance reminder, never for booking consent.
export function isAttendanceConfirmation(text) {
  return isAgreement(text) || /^(oui(?: merci)?|yes|ok(?:ay)?|d[’']accord|نعم|ايه|واه|موافق)[.!،\s]*$/iu.test(text.trim());
}
