const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const roster = require('./roster');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireRoster(res) {
  const data = roster.getRoster();
  if (!data) res.status(500).json({ error: 'Shift file not found' });
  return data;
}

function dateParam(req, res) {
  const key = req.query.date || roster.todayKey();
  if (!roster.isValidKey(key)) {
    res.status(400).json({ error: 'Invalid date, expected YYYY-MM-DD' });
    return null;
  }
  return key;
}

function pinMatches(req) {
  const given = Buffer.from(String(req.get('x-admin-pin') || ''));
  const expected = Buffer.from(config.adminPin);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Day edits are open unless ADMIN_PIN is set, in which case the x-admin-pin header must match.
function checkPin(req, res, next) {
  if (!config.adminPin || pinMatches(req)) return next();
  res.status(401).json({ error: 'PIN required' });
}

// Roster file changes always need a PIN; they are disabled until ADMIN_PIN is set.
function requirePin(req, res, next) {
  if (!config.adminPin) return res.status(403).json({ error: 'Set ADMIN_PIN on the server to enable roster uploads' });
  if (pinMatches(req)) return next();
  res.status(401).json({ error: 'PIN required' });
}

// --- Meta ---
app.get('/api/meta', (req, res) => {
  const data = roster.getRoster();
  res.json({
    today: roster.todayKey(),
    files: data?.files || [],
    range: data ? { start: data.dateKeys[0], end: data.dateKeys[data.dateKeys.length - 1] } : null,
    ignoredDates: data?.ignoredDates || 0,
    employees: data ? data.employees.map(e => e.name) : [],
    shiftCodes: Object.entries(config.shiftMap).map(([code, label]) => ({ code, label })),
    pinRequired: !!config.adminPin,
    uploadsEnabled: !!config.adminPin
  });
});

// --- Roster files: list, upload, download, archive ---
const MAX_UPLOAD = 5 * 1024 * 1024;

function safeRosterName(name) {
  let base = path.basename(String(name || '')).replace(/[^\w .()&-]/g, '').replace(/\s+/g, ' ').trim();
  if (!base.toLowerCase().endsWith('.xlsx')) base += '.xlsx';
  // Needs a real name before the extension, and no leading dot (no hidden files).
  return /^[\w(]/.test(base) && base.length > 5 && base.length <= 120 ? base : null;
}

function rosterPath(name) {
  const safe = safeRosterName(name);
  if (!safe) return null;
  const p = path.join(roster.ROSTER_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

app.get('/api/rosters', (req, res) => {
  const data = roster.getRoster();
  res.json({ files: data?.files || [], uploadsEnabled: !!config.adminPin });
});

app.post('/api/rosters', requirePin, express.raw({ type: '*/*', limit: MAX_UPLOAD }), (req, res) => {
  const name = safeRosterName(req.query.name);
  if (!name) return res.status(400).json({ error: 'Invalid file name — use a normal name ending in .xlsx' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100) return res.status(400).json({ error: 'Empty file' });
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return res.status(400).json({ error: 'Not an .xlsx file' });

  let parsed;
  try { parsed = roster.inspectWorkbook(buf); } catch (e) { parsed = null; }
  if (!parsed || !parsed.dates.length) return res.status(400).json({ error: 'No dates found in the first row (expected dates from column C onward)' });
  if (!parsed.employees.length) return res.status(400).json({ error: 'No employee names found in column B' });

  const dest = path.join(roster.ROSTER_DIR, name);
  const replaced = fs.existsSync(dest);
  const tmp = dest + '.upload';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);

  const before = roster.getRoster();
  const overlaps = (before?.files || []).filter(f => f.file !== name && f.start <= parsed.end && parsed.start <= f.end).map(f => f.file);
  console.log(`[roster] uploaded ${name} (${parsed.start} → ${parsed.end}, ${parsed.employees.length} people)`);
  res.json({
    success: true, file: name, replaced, start: parsed.start, end: parsed.end,
    employees: parsed.employees.length, ignoredDates: parsed.ignoredDates, overlaps
  });
});

app.get('/api/rosters/:file', (req, res) => {
  const p = rosterPath(req.params.file);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.download(p);
});

// Archive instead of delete, so a mistaken click can be undone on the server.
app.delete('/api/rosters/:file', requirePin, (req, res) => {
  const p = rosterPath(req.params.file);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const archive = path.join(roster.ROSTER_DIR, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(p, path.join(archive, `${stamp} ${path.basename(p)}`));
  res.json({ success: true });
});

// --- Daily data (dashboard edits) ---
app.get('/api/daily-data', (req, res) => {
  const key = dateParam(req, res);
  if (key) res.json(store.get(key));
});

app.post('/api/daily-data', checkPin, (req, res) => {
  const { date, inCharge, shiftOverrides } = req.body || {};
  if (!roster.isValidKey(date)) return res.status(400).json({ error: 'Valid date required' });
  if (shiftOverrides && Object.values(shiftOverrides).some(c => !config.shiftMap[c])) {
    return res.status(400).json({ error: 'Unknown shift code' });
  }
  res.json({ success: true, data: store.update(date, { inCharge, shiftOverrides }) });
});

// --- Roster for one day ---
app.get('/api/roster', (req, res) => {
  try {
    const key = dateParam(req, res);
    if (!key) return;
    const data = requireRoster(res);
    if (!data) return;

    const day = roster.getDay(key, data);
    res.json({
      date: key,
      today: roster.todayKey(),
      dayName: roster.dayName(key),
      dateFormatted: roster.formatKey(key, { day: 'numeric', month: 'short', year: 'numeric' }),
      isEid: day.isEid,
      notFound: !day.found,
      availableDates: data.dateKeys,
      entries: day.entries,
      daily: store.get(key),
      shiftOrder: config.shiftOrder,
      shiftCodes: Object.entries(config.shiftMap).map(([code, label]) => ({ code, label })),
      workingCodes: roster.WORKING_CODES,
      requiredShifts: config.requiredShifts,
      inChargePriority: config.inChargePriority
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Week grid ---
app.get('/api/week', (req, res) => {
  const key = dateParam(req, res);
  if (!key) return;
  const data = requireRoster(res);
  if (!data) return;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 31);
  res.json({ start: key, today: roster.todayKey(), ...roster.getWeek(key, days, data) });
});

// --- One employee's upcoming shifts ---
app.get('/api/employee', (req, res) => {
  const data = requireRoster(res);
  if (!data) return;
  const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 62);
  const sched = roster.employeeSchedule(req.query.name, req.query.from || roster.todayKey(), days, data);
  if (!sched) return res.status(404).json({ error: 'Employee not found' });
  res.json(sched);
});

// --- Office Now ---
app.get('/api/office-now', (req, res) => {
  try {
    const data = requireRoster(res);
    if (!data) return;
    res.json(roster.officeNow(data));
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Salary & roster countdown ---
app.get('/api/salary', (req, res) => {
  res.json({ ...roster.salaryInfo(), roster: roster.rosterCountdown() });
});

app.get('/healthz', (req, res) => res.json({ ok: true, roster: !!roster.getRoster() }));

// Keep alive — ping self every 14 min to prevent Render free tier sleep
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    setInterval(() => {
      require('https').get(`${url}/healthz`, () => {}).on('error', () => {});
    }, 14 * 60 * 1000);
  }
}

if (require.main === module || process.env.START_DASHBOARD !== 'false') {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
    keepAlive();
  });
}

module.exports = app;
