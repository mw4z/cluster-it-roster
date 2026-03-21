const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const axios = require('axios');
const config = require('./config');

const { daysEn, shiftMap, shiftOrder, weatherApiKey, salaryDay, employeeStartRow, employeeEndRow } = config;

function formatEnglishDays(num) {
  if (num === 0) return '0 days';
  if (num === 1) return '1 day';
  if (num === 2) return '2 days';
  return `${num} days`;
}

function loadWorkbook() {
  const fileName = fs.readdirSync(__dirname).find(f => f.endsWith('.xlsx'));
  if (!fileName) return null;
  try {
    const workbook = XLSX.readFile(path.join(__dirname, fileName));
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  } catch (e) {
    console.error('Failed to read Excel file:', e.message);
    return null;
  }
}

// Parse date from cell — handles both numeric Excel dates and strings like "3/20/2025 EID"
function parseCellDate(cell, fallbackYear) {
  if (typeof cell === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + cell * 86400000);
  }
  if (typeof cell === 'string' && cell.trim()) {
    // Handle "3/20/2025 EID" or "3/20/2025" format
    const dateStr = cell.trim().replace(/\s+(EID|eid).*/i, '');
    // Parse as UTC to avoid timezone shifts
    const parts = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (parts) {
      return new Date(Date.UTC(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2])));
    }
    const parsed = new Date(dateStr + ' UTC');
    if (!isNaN(parsed)) return parsed;
    const withYear = new Date(`${dateStr} ${fallbackYear} UTC`);
    if (!isNaN(withYear)) return withYear;
  }
  return null;
}

function findDateColumn(firstRow, targetDate) {
  const targetFormatted = targetDate
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    .replace(' ', '-')
    .toLowerCase();

  for (let i = 2; i < firstRow.length; i++) {
    const cellDate = parseCellDate(firstRow[i], targetDate.getFullYear());
    if (!cellDate) continue;

    const colFormatted = cellDate
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      .replace(' ', '-')
      .toLowerCase();

    if (colFormatted === targetFormatted) return i;
  }
  return -1;
}

// Parse shift value from a cell, returns { code, label, calledIn, rawTime }
function parseShift(cellValue) {
  let raw = (cellValue || '').toString().trim();
  if (!raw) return null;

  // Detect flags
  const calledIn = /[-]?z$/i.test(raw);
  const pendingOff = /[-]?x$/i.test(raw);
  raw = raw.replace(/[-]?[zx]$/i, '').trim();

  if (!raw) return null;

  // Try direct code match
  const upper = raw.toUpperCase();
  if (shiftMap[upper]) {
    return {
      code: upper,
      label: shiftMap[upper],
      calledIn,
      rawTime: null
    };
  }

  // Try time-range classification
  const code = config.classifyTimeShift(raw);
  if (code && shiftMap[code]) {
    return {
      code,
      label: shiftMap[code],
      calledIn,
      rawTime: raw
    };
  }

  return null;
}

async function getTodayRosterMessage(includeExtras = true, isTomorrow = false) {
  const dt = new Date();
  if (isTomorrow) dt.setDate(dt.getDate() + 1);

  const label = isTomorrow ? "Tomorrow's Roster" : "Today's Roster";
  const dayName = daysEn[dt.getDay()];
  const dateFormatted = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace(' ', '-');

  let message = '';

  // Weather
  if (includeExtras && weatherApiKey) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=Mecca,SA&units=metric&lang=en&appid=${weatherApiKey}`;
      const resp = await axios.get(url, { timeout: 5000 });
      if (resp.status === 200 && resp.data?.weather && resp.data?.main) {
        const w = resp.data;
        message += `📍Weather: ${w.weather[0].description}, Currently ${Math.round(w.main.temp)}°C 🌡️\n\n`;
      }
    } catch (e) {
      console.warn('Weather API failed:', e.message);
    }
  }

  message += `*${label} - ${dayName}, ${dateFormatted} 📋:*\n\n`;

  // Load Excel
  const rawData = loadWorkbook();
  if (!rawData) return '❌ Shift file not found or could not be read.';

  const firstRow = rawData[0];
  const dateCol = findDateColumn(firstRow, dt);
  if (dateCol === -1) return '⚠️ Date column not found in roster.';

  // Check if this date is an EID/holiday
  const headerCell = (firstRow[dateCol] || '').toString();
  if (/eid/i.test(headerCell)) {
    message += '🌙✨ *Eid Mubarak!* ✨🌙\n\n';
  }

  // Build roster (flat list, no hotels)
  const grouped = {};

  for (let i = employeeStartRow; i <= Math.min(employeeEndRow, rawData.length - 1); i++) {
    const row = rawData[i];
    const name = (row[1] || '').toString().trim();
    if (!name) continue;

    const shift = parseShift(row[dateCol]);
    if (!shift) continue;

    const displayLabel = shift.label;
    if (!grouped[displayLabel]) grouped[displayLabel] = [];

    let entry = name;
    if (shift.rawTime) entry += ` (${shift.rawTime})`;
    if (shift.calledIn) entry += ' 🚨 Called in';

    grouped[displayLabel].push(entry);
  }

  if (Object.keys(grouped).length === 0) {
    message += '⚠️ No shifts found for this date.\n';
  } else {
    for (const shiftLabel of shiftOrder) {
      if (grouped[shiftLabel]) {
        message += `${shiftLabel}:\n` + grouped[shiftLabel].map(p => `- ${p}`).join('\n') + '\n\n';
      }
    }
  }

  message = message.trim();

  // Extras: roster countdown + salary countdown
  if (includeExtras) {
    const todayIndex = findDateColumn(firstRow, new Date());
    const totalDays = todayIndex !== -1
      ? firstRow.slice(todayIndex).filter(x => x).length
      : 0;

    const today = new Date();
    const todayDay = today.getDate();
    const afterSalary = todayDay > salaryDay;
    const nextMonth = afterSalary ? today.getMonth() + 1 : today.getMonth();
    const nextYear = afterSalary && today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
    const salaryDate = new Date(nextYear, nextMonth, salaryDay);
    const daysToSalary = Math.ceil((salaryDate - today) / (1000 * 60 * 60 * 24));

    message += `\n\n📅 *${formatEnglishDays(totalDays)} left until the current roster ends*`;
    message += `\n*💰 ${formatEnglishDays(daysToSalary)} left until salary*`;
  }

  return message;
}

module.exports = {
  getTodayRosterMessage,
  loadWorkbook,
  findDateColumn,
  parseShift,
  parseCellDate
};
