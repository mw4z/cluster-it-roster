// roster.js — single source of truth for reading the roster spreadsheet.
// Everything works on Riyadh-local date keys ("YYYY-MM-DD") so the bot and the
// dashboard agree regardless of the server's own timezone (Render runs in UTC).

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const config = require('./config');

const TZ = 'Asia/Riyadh';
const ROSTER_DIR = process.env.ROSTER_DIR || path.join(__dirname, 'rosters');
const WORKING_CODES = ['M', 'B', 'E', 'N'];
const ON_DUTY_CODES = [...WORKING_CODES, 'T', 'TR'];

// Default shift windows in Riyadh hours [start, end). Night wraps past midnight.
const SHIFT_WINDOWS = { M: [8, 17], B: [12, 21], E: [15, 23], N: [23, 32] };

// ---------- Time helpers ----------

function riyadhNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    time: `${parts.hour}:${parts.minute}`
  };
}

function todayKey(offsetDays = 0) {
  return addDays(riyadhNow().key, offsetDays);
}

function keyToUTC(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToKey(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(key, n) {
  const d = keyToUTC(key);
  d.setUTCDate(d.getUTCDate() + n);
  return utcToKey(d);
}

function daysBetween(fromKey, toKey) {
  return Math.round((keyToUTC(toKey) - keyToUTC(fromKey)) / 86400000);
}

function dayName(key) {
  return config.daysEn[keyToUTC(key).getUTCDay()];
}

function formatKey(key, opts = { day: 'numeric', month: 'short' }) {
  return keyToUTC(key).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

function isValidKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key || '') && !isNaN(keyToUTC(key));
}

// ---------- Names ----------

// "Hassan, Islam", "  Islam Hassan" and "islam hassan" all normalise to "hassan islam".
function normalizeName(name) {
  return (name || '').toString().toLowerCase().replace(/[,.]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Same person despite small spelling differences between sheets:
// "Mohamed Alkhatabi" = "Mohammed Alkhattabi", "Abdulmajeed" = "Abdulmajed".
// Every word must match, allowing one typo per word (two for long words).
function sameName(a, b) {
  const ta = normalizeName(a).split(' ');
  const tb = normalizeName(b).split(' ');
  if (!ta[0] || ta.length !== tb.length) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  const used = new Set();
  return ta.every(t => {
    const j = tb.findIndex((u, k) => !used.has(k) && editDistance(t, u) <= (Math.min(t.length, u.length) >= 8 ? 2 : 1));
    if (j === -1) return false;
    used.add(j);
    return true;
  });
}

function cleanName(name) {
  return (name || '').toString().replace(/\s+/g, ' ').trim();
}

// ---------- Cell parsing ----------

function parseCellDate(cell) {
  if (typeof cell === 'number') {
    return utcToKey(new Date(Date.UTC(1899, 11, 30) + Math.round(cell) * 86400000));
  }
  if (typeof cell === 'string' && cell.trim()) {
    const m = cell.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return utcToKey(new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])));
  }
  return null;
}

// Returns { code, label, calledIn, pendingOff, rawTime } or null.
// Suffixes: "-z" = called in on a pending-off day, "-x" = pending off taken.
function parseShift(cellValue) {
  let raw = (cellValue ?? '').toString().trim();
  if (!raw) return null;

  // A bare code wins first, so "Z", "X" and "EX" are not mistaken for suffixed shifts.
  const direct = raw.toUpperCase();
  if (config.shiftMap[direct]) {
    return { code: direct, label: config.shiftMap[direct], calledIn: false, pendingOff: false, rawTime: null };
  }

  const calledIn = /-?z$/i.test(raw);
  const pendingOff = /-?x$/i.test(raw);
  raw = raw.replace(/-?[zx]$/i, '').trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (config.shiftMap[upper]) {
    return { code: upper, label: config.shiftMap[upper], calledIn, pendingOff, rawTime: null };
  }

  const code = config.classifyTimeShift(raw);
  if (code && config.shiftMap[code]) {
    return { code, label: config.shiftMap[code], calledIn, pendingOff, rawTime: raw };
  }
  return null;
}

// Shift window in Riyadh hours, honouring explicit times like "8:00 AM - 14:00 PM".
function shiftWindow(shift) {
  if (shift.rawTime) {
    const m = shift.rawTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      const to24 = (h, min, p) => {
        h = parseInt(h, 10);
        if (p && p.toUpperCase() === 'PM' && h < 12) h += 12;
        if (p && p.toUpperCase() === 'AM' && h === 12) h = 0;
        return h + parseInt(min, 10) / 60;
      };
      const start = to24(m[1], m[2], m[3]);
      let end = to24(m[4], m[5], m[6]);
      if (end <= start) end += 24;
      return [start, end];
    }
  }
  return SHIFT_WINDOWS[shift.code] || null;
}

// ---------- Workbook loading ----------
// Every .xlsx in ROSTER_DIR is a roster. They are merged by date into one timeline;
// when two files cover the same date, the most recently uploaded file wins.

const fileCache = new Map(); // file -> { mtimeMs, parsed }
let merged = { signature: null, roster: null };

function listRosterFiles() {
  if (!fs.existsSync(ROSTER_DIR)) fs.mkdirSync(ROSTER_DIR, { recursive: true });
  return fs.readdirSync(ROSTER_DIR)
    .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .map(f => ({ file: f, mtimeMs: fs.statSync(path.join(ROSTER_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first, newest last
}

// Keep the longest run of consecutive dates. Old template columns
// (e.g. leftover April dates before a September roster) are dropped.
function longestConsecutiveRun(dates) {
  let best = [], run = [];
  for (const d of dates) {
    if (run.length && daysBetween(run[run.length - 1].key, d.key) !== 1) run = [];
    run.push(d);
    if (run.length > best.length) best = run.slice();
  }
  return best;
}

function parseSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) return null;

  const header = rows[0];
  const allDates = [];
  for (let col = 2; col < header.length; col++) {
    const key = parseCellDate(header[col]);
    if (key) allDates.push({ key, col, isEid: /eid/i.test(header[col].toString()) });
  }
  const dates = longestConsecutiveRun(allDates);

  // Employees start at employeeStartRow and run until the first blank name, or
  // until the legend block (rows like "M | Morning Shift" with a code in column A).
  const employees = [];
  for (let i = config.employeeStartRow; i < rows.length; i++) {
    const name = cleanName(rows[i][1]);
    if (!name) break;
    const first = rows[i][0];
    if (typeof first === 'string' && first.trim() && !/^\d+$/.test(first.trim())) break;
    const cells = {};
    for (const d of dates) cells[d.key] = rows[i][d.col];
    employees.push({ name, cells });
  }
  return { dates, allDates, employees };
}

// Uses the leftmost visible sheet that looks like a roster (dates in row 1,
// names in column B). Copies like "NOV (2)" placed first win over older tabs.
function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const meta = workbook.Workbook?.Sheets || [];
  const visible = workbook.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden));
  let picked = null, sheetName = null;
  for (const name of visible) {
    const parsed = parseSheet(workbook.Sheets[name]);
    if (parsed && parsed.dates.length && parsed.employees.length) { picked = parsed; sheetName = name; break; }
  }
  if (!picked) return null;
  const { dates, allDates, employees } = picked;

  return {
    sheet: sheetName,
    otherSheets: visible.filter(n => n !== sheetName),
    dates,
    ignoredDates: allDates.length - dates.length,
    employees,
    start: dates.length ? dates[0].key : null,
    end: dates.length ? dates[dates.length - 1].key : null
  };
}

function parseCached(entry) {
  const hit = fileCache.get(entry.file);
  if (hit && hit.mtimeMs === entry.mtimeMs) return hit.parsed;
  let parsed = null;
  try {
    parsed = parseWorkbook(path.join(ROSTER_DIR, entry.file));
    if (parsed && parsed.ignoredDates) {
      console.warn(`[roster] ${entry.file}: ignored ${parsed.ignoredDates} date column(s) outside the main date range`);
    }
  } catch (e) {
    console.error(`[roster] failed to read ${entry.file}:`, e.message);
  }
  fileCache.set(entry.file, { mtimeMs: entry.mtimeMs, parsed });
  return parsed;
}

function mergeRosters(entries) {
  const files = [];
  const owner = new Map();      // date key -> { fileIdx, isEid }
  for (const entry of entries) {
    const parsed = parseCached(entry);
    if (!parsed || !parsed.dates.length || !parsed.employees.length) continue;
    const idx = files.length;
    files.push({ file: entry.file, uploadedAt: new Date(entry.mtimeMs).toISOString(), ...parsed });
    for (const d of parsed.dates) owner.set(d.key, { fileIdx: idx, isEid: d.isEid }); // newer files overwrite
  }

  const dateKeys = [...owner.keys()].sort();
  const people = new Map();     // person key -> { name, cells }
  const keyFor = name => {
    for (const k of people.keys()) if (sameName(k, name)) return k;
    return normalizeName(name);
  };
  // Iterate oldest -> newest so the newest spelling of a name is kept.
  files.forEach((f, idx) => {
    for (const emp of f.employees) {
      const k = keyFor(emp.name);
      if (!people.has(k)) people.set(k, { name: emp.name, cells: {} });
      const p = people.get(k);
      p.name = emp.name;
      for (const d of f.dates) if (owner.get(d.key).fileIdx === idx) p.cells[d.key] = emp.cells[d.key];
    }
  });
  // Keep the newest file's row order, then anyone only in older files.
  const order = [];
  for (let i = files.length - 1; i >= 0; i--) {
    for (const emp of files[i].employees) {
      const k = keyFor(emp.name);
      if (!order.includes(k)) order.push(k);
    }
  }

  return {
    files: files.map(f => ({
      file: f.file, uploadedAt: f.uploadedAt, start: f.start, end: f.end,
      sheet: f.sheet, otherSheets: f.otherSheets,
      employees: f.employees.length, ignoredDates: f.ignoredDates,
      activeDays: f.dates.filter(d => files[owner.get(d.key).fileIdx] === f).length
    })),
    dateKeys,
    eidKeys: new Set(dateKeys.filter(k => owner.get(k).isEid)),
    ignoredDates: files.reduce((n, f) => n + f.ignoredDates, 0),
    employees: order.map(k => people.get(k))
  };
}

function getRoster() {
  let entries;
  try { entries = listRosterFiles(); } catch (e) { console.error('[roster]', e.message); return null; }
  if (!entries.length) return null;
  const signature = entries.map(e => `${e.file}:${e.mtimeMs}`).join('|');
  if (merged.signature !== signature) merged = { signature, roster: mergeRosters(entries) };
  return merged.roster.dateKeys.length ? merged.roster : null;
}

// Parse a buffer without saving it, to validate uploads.
function inspectWorkbook(buffer) {
  const tmp = path.join(require('os').tmpdir(), `roster-${process.pid}-${Date.now()}.xlsx`);
  fs.writeFileSync(tmp, buffer);
  try { return parseWorkbook(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

// ---------- Queries ----------

function getDay(key, roster = getRoster()) {
  if (!roster) return null;
  const found = roster.dateKeys.includes(key);
  const entries = [];
  if (found) {
    for (const emp of roster.employees) {
      const shift = parseShift(emp.cells[key]);
      if (shift) entries.push({ name: emp.name, ...shift });
    }
  }
  return { key, found, isEid: roster.eidKeys.has(key), entries };
}

function groupByLabel(entries) {
  const groups = {};
  for (const e of entries) (groups[e.label] ||= []).push(e);
  return config.shiftOrder.filter(l => groups[l]).map(label => ({ label, employees: groups[label] }));
}

// Who is on shift right now, considering yesterday's night shift too.
function officeNow(roster = getRoster()) {
  const now = riyadhNow();
  const hourNow = now.hour + now.minute / 60;
  const people = [];
  const activeCodes = new Set();

  for (const [offset, key] of [[-1, addDays(now.key, -1)], [0, now.key]]) {
    const day = getDay(key, roster);
    if (!day) continue;
    for (const e of day.entries) {
      if (!WORKING_CODES.includes(e.code)) continue;
      const win = shiftWindow(e);
      if (!win) continue;
      const t = hourNow - offset * 24; // hours since start of that roster day
      if (t >= win[0] && t < win[1]) {
        people.push({ name: e.name, shiftCode: e.code, label: e.label, rawTime: e.rawTime, calledIn: e.calledIn });
        activeCodes.add(e.code);
      }
    }
  }
  return { time: now.time, activeShifts: WORKING_CODES.filter(c => activeCodes.has(c)), employees: people };
}

function salaryInfo() {
  const today = todayKey();
  const [y, m, d] = today.split('-').map(Number);
  let year = y, month = m;
  if (d > config.salaryDay) { month += 1; if (month > 12) { month = 1; year += 1; } }
  const salaryDate = `${year}-${String(month).padStart(2, '0')}-${String(config.salaryDay).padStart(2, '0')}`;
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  const cycleLength = daysBetween(`${prev}-${String(config.salaryDay).padStart(2, '0')}`, salaryDate);
  return { daysLeft: daysBetween(today, salaryDate), salaryDate, cycleLength };
}

function rosterCountdown(roster = getRoster()) {
  if (!roster || !roster.dateKeys.length) return null;
  const today = todayKey();
  const current = roster.files.find(f => f.start <= today && today <= f.end)
    || roster.files.find(f => f.start > today)
    || roster.files[roster.files.length - 1];
  const end = current.end;
  return {
    file: current.file,
    start: current.start,
    end,
    lastDate: roster.dateKeys[roster.dateKeys.length - 1],
    daysLeft: Math.max(0, daysBetween(today, end) + 1), // includes today
    ended: today > roster.dateKeys[roster.dateKeys.length - 1]
  };
}

// Employees × days grid.
function getWeek(startKey, days = 7, roster = getRoster()) {
  if (!roster) return null;
  const keys = Array.from({ length: days }, (_, i) => addDays(startKey, i));
  return {
    days: keys.map(k => ({ key: k, dayName: dayName(k), short: formatKey(k), inRoster: roster.dateKeys.includes(k), isEid: roster.eidKeys.has(k) })),
    employees: roster.employees.map(emp => ({
      name: emp.name,
      shifts: keys.map(k => {
        const s = parseShift(emp.cells[k]);
        return s ? { code: s.code, label: s.label, calledIn: s.calledIn, pendingOff: s.pendingOff, rawTime: s.rawTime } : null;
      })
    })),
    coverage: keys.map(k => coverage(getDay(k, roster)))
  };
}

// Count of people per working shift for a day, plus gaps.
function coverage(day) {
  const counts = Object.fromEntries(WORKING_CODES.map(c => [c, 0]));
  if (day) for (const e of day.entries) if (counts[e.code] !== undefined) counts[e.code]++;
  // A required shift counts as covered when someone works at least half of its hours,
  // so a 12-hour "8:00 AM - 8:00 PM" shift also covers most of Evening.
  const covered = code => {
    const [s, e] = SHIFT_WINDOWS[code];
    return day.entries.some(x => {
      if (!WORKING_CODES.includes(x.code)) return false;
      const w = shiftWindow(x);
      return w && Math.min(e, w[1]) - Math.max(s, w[0]) >= (e - s) / 2;
    });
  };
  const gaps = day && day.found ? config.requiredShifts.filter(c => !covered(c)) : [];
  return { counts, gaps };
}

// Find the roster employee matching a name, a "Last, First" form or a first name.
function findEmployee(query, roster = getRoster()) {
  if (!roster || !query) return null;
  const q = normalizeName(query);
  const exact = roster.employees.find(e => normalizeName(e.name) === q)
    || roster.employees.find(e => sameName(e.name, query));
  if (exact) return exact;
  const tokens = q.split(' ');
  const partial = roster.employees.filter(e => {
    const n = normalizeName(e.name).split(' ');
    return tokens.every(t => n.includes(t));
  });
  return partial.length === 1 ? partial[0] : null;
}

function employeeSchedule(name, fromKey = todayKey(), days = 7, roster = getRoster()) {
  const emp = findEmployee(name, roster);
  if (!emp) return null;
  return {
    name: emp.name,
    days: Array.from({ length: days }, (_, i) => {
      const k = addDays(fromKey, i);
      return { key: k, dayName: dayName(k), short: formatKey(k), inRoster: roster.dateKeys.includes(k), shift: parseShift(emp.cells[k]) };
    })
  };
}

// Pick the in-charge for a shift: manual override, else first name in priority order.
function pickInCharge(names, override) {
  if (override && names.includes(override)) return { name: override, manual: true };
  for (const p of config.inChargePriority) {
    const match = names.find(n => sameName(n, p));
    if (match) return { name: match, manual: false };
  }
  return null;
}

module.exports = {
  TZ, WORKING_CODES, ON_DUTY_CODES,
  riyadhNow, todayKey, addDays, daysBetween, dayName, formatKey, isValidKey,
  normalizeName, sameName, parseCellDate, parseShift, shiftWindow,
  ROSTER_DIR, getRoster, inspectWorkbook, getDay, groupByLabel, officeNow, salaryInfo, rosterCountdown,
  getWeek, coverage, findEmployee, employeeSchedule, pickInCharge
};
