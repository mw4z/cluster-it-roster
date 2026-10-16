// main.js — WhatsApp message builders on top of roster.js
const config = require('./config');
const roster = require('./roster');
const store = require('./store');

function formatEnglishDays(num) {
  return num === 1 ? '1 day' : `${num} days`;
}

async function getWeatherLine() {
  if (!config.weatherApiKey) return '';
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=Mecca,SA&units=metric&lang=en&appid=${config.weatherApiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return '';
    const w = await resp.json();
    return `📍Weather: ${w.weather[0].description}, Currently ${Math.round(w.main.temp)}°C 🌡️\n\n`;
  } catch (e) {
    console.warn('Weather API failed:', e.message);
    return '';
  }
}

// Applies dashboard edits (shift overrides) to a day's entries.
function applyOverrides(day) {
  const overrides = store.get(day.key).shiftOverrides || {};
  return day.entries.map(e => {
    const code = overrides[e.name];
    if (!code || !config.shiftMap[code]) return e;
    return { ...e, code, label: config.shiftMap[code], rawTime: null, modified: true };
  });
}

async function getTodayRosterMessage(includeExtras = true, isTomorrow = false) {
  const key = roster.todayKey(isTomorrow ? 1 : 0);
  const label = isTomorrow ? "Tomorrow's Roster" : "Today's Roster";

  const data = roster.getRoster();
  if (!data) return '❌ Shift file not found or could not be read.';
  const day = roster.getDay(key, data);
  if (!day.found) return `⚠️ ${roster.formatKey(key)} is not in the current roster (${data.dateKeys[0]} → ${data.dateKeys[data.dateKeys.length - 1]}).`;

  let message = includeExtras ? await getWeatherLine() : '';
  message += `*${label} - ${roster.dayName(key)}, ${roster.formatKey(key).replace(' ', '-')} 📋:*\n\n`;
  if (day.isEid) message += '🌙✨ *Eid Mubarak!* ✨🌙\n\n';

  const entries = applyOverrides(day);
  const groups = roster.groupByLabel(entries);
  const inCharge = store.get(key).inCharge || {};

  if (!groups.length) {
    message += '⚠️ No shifts found for this date.\n';
  } else {
    for (const g of groups) {
      const isWorking = roster.WORKING_CODES.includes(g.employees[0].code);
      const ic = isWorking ? roster.pickInCharge(g.employees.map(e => e.name), inCharge[g.label]) : null;
      message += `${g.label}:\n` + g.employees.map(e => {
        let entry = `- ${e.name}`;
        if (e.rawTime) entry += ` (${e.rawTime})`;
        if (ic && ic.name === e.name) entry += ' 🔑';
        if (e.calledIn) entry += ' 🚨 Called in';
        if (e.pendingOff) entry += ' (pending off)';
        return entry;
      }).join('\n') + '\n\n';
    }
  }

  const { gaps } = roster.coverage({ ...day, entries });
  if (gaps.length) {
    message += `⚠️ *No one on:* ${gaps.map(c => config.shiftMap[c]).join(', ')}\n\n`;
  }

  message = message.trim();

  if (includeExtras) {
    const rc = roster.rosterCountdown(data);
    const salary = roster.salaryInfo();
    if (rc) message += `\n\n📅 *${formatEnglishDays(rc.daysLeft)} left until the current roster ends*`;
    message += `\n*💰 ${formatEnglishDays(salary.daysLeft)} left until salary*`;
  }
  return message;
}

function getMyScheduleMessage(rosterName, days = 7) {
  const sched = roster.employeeSchedule(rosterName, roster.todayKey(), days);
  if (!sched) return null;
  const lines = sched.days.map(d => {
    const when = `${d.dayName.slice(0, 3)} ${d.short}`;
    if (!d.inRoster) return `${when}: — not in roster yet`;
    if (!d.shift) return `${when}: —`;
    let s = `${when}: ${d.shift.label}`;
    if (d.shift.rawTime) s += ` (${d.shift.rawTime})`;
    if (d.shift.calledIn) s += ' 🚨';
    return s;
  });
  return `🗓️ *${sched.name} — next ${days} days:*\n\n` + lines.join('\n');
}

module.exports = {
  getTodayRosterMessage,
  getMyScheduleMessage,
  formatEnglishDays
};
