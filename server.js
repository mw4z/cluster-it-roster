const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const config = require('./config');
const { loadWorkbook, findDateColumn, parseShift, parseCellDate } = require('./main');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TZ = 'Asia/Riyadh';

function nowInRiyadh() {
  const str = new Date().toLocaleString('en-CA', { timeZone: TZ, hour12: false });
  return new Date(str);
}

// --- MongoDB connection ---
let db = null;
async function getDb() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  try {
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db('cluster-roster');
    console.log('Connected to MongoDB');
    return db;
  } catch (e) {
    console.error('MongoDB connection failed:', e.message);
    return null;
  }
}

// --- Daily Data storage (MongoDB with in-memory cache) ---
const cache = {};

async function loadDailyData(date) {
  const empty = { occupancy: {}, hotelInCharge: {}, inCharge: {} };
  if (cache[date]) return cache[date];
  const mongo = await getDb();
  if (mongo) {
    const doc = await mongo.collection('dailyData').findOne({ _id: date });
    if (doc) { delete doc._id; cache[date] = doc; return doc; }
    cache[date] = empty;
    return empty;
  }
  // File fallback (local dev)
  try {
    if (fs.existsSync(DATA_FILE)) {
      const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      cache[date] = all[date] || empty;
      return cache[date];
    }
  } catch (e) {}
  return empty;
}

async function saveDailyData(date, data) {
  cache[date] = data;
  const mongo = await getDb();
  if (mongo) {
    await mongo.collection('dailyData').updateOne(
      { _id: date }, { $set: data }, { upsert: true }
    );
    return;
  }
  // File fallback (local dev)
  let all = {};
  try {
    if (fs.existsSync(DATA_FILE)) all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  all[date] = data;
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET daily data for a date
app.get('/api/daily-data', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date required' });
  res.json(await loadDailyData(date));
});

// POST save daily data for a date
app.post('/api/daily-data', async (req, res) => {
  const { date, occupancy, hotelInCharge, inCharge } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  await saveDailyData(date, { occupancy: occupancy || {}, hotelInCharge: hotelInCharge || {}, inCharge: inCharge || {} });
  res.json({ success: true });
});

// --- Roster API ---
app.get('/api/roster', (req, res) => {
  try {
    const { date } = req.query;
    const dt = date ? new Date(date) : new Date();
    if (isNaN(dt)) return res.status(400).json({ error: 'Invalid date' });

    const rawData = loadWorkbook();
    if (!rawData) return res.status(500).json({ error: 'Shift file not found' });

    const firstRow = rawData[0];
    const dateCol = findDateColumn(firstRow, dt);
    const { shiftMap, shiftOrder, daysEn, employeeStartRow, employeeEndRow } = config;

    const currentYear = nowInRiyadh().getFullYear();
    const availableDates = [];
    for (let i = 2; i < firstRow.length; i++) {
      const cellDate = parseCellDate(firstRow[i], dt.getFullYear());
      if (cellDate && !isNaN(cellDate)) {
        const m = String(cellDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(cellDate.getUTCDate()).padStart(2, '0');
        availableDates.push(`${currentYear}-${m}-${d}`);
      }
    }

    if (dateCol === -1) {
      const nfDate = new Date(Date.UTC(currentYear, dt.getUTCMonth(), dt.getUTCDate()));
      return res.json({
        date: formatDate(nfDate),
        dayName: daysEn[nfDate.getUTCDay()],
        dateFormatted: nfDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
        isEid: false, shifts: [], availableDates, notFound: true
      });
    }

    // Get actual date from Excel column
    const actualDate = parseCellDate(firstRow[dateCol], dt.getFullYear());
    const headerCell = (firstRow[dateCol] || '').toString();
    const isEid = /eid/i.test(headerCell);

    // Use current year for day name display (Excel may have different year)
    const now = nowInRiyadh();
    const displayDate = actualDate ? new Date(Date.UTC(now.getFullYear(), actualDate.getUTCMonth(), actualDate.getUTCDate())) : dt;

    const shifts = {};
    for (let i = employeeStartRow; i <= Math.min(employeeEndRow, rawData.length - 1); i++) {
      const row = rawData[i];
      const name = (row[1] || '').toString().trim();
      if (!name) continue;
      const shift = parseShift(row[dateCol]);
      if (!shift) continue;
      if (!shifts[shift.label]) shifts[shift.label] = [];
      shifts[shift.label].push({
        name, calledIn: shift.calledIn, shiftCode: shift.code, rawTime: shift.rawTime
      });
    }

    const sortedShifts = [];
    for (const label of shiftOrder) {
      if (shifts[label]) sortedShifts.push({ label, employees: shifts[label] });
    }

    res.json({
      date: formatDate(displayDate),
      dayName: daysEn[displayDate.getUTCDay()],
      dateFormatted: displayDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      isEid, shifts: sortedShifts, availableDates
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Office Now API ---
app.get('/api/office-now', (req, res) => {
  try {
    const rawData = loadWorkbook();
    if (!rawData) return res.status(500).json({ error: 'Shift file not found' });

    const now = nowInRiyadh();
    const hour = now.getHours();
    const adjustedDate = nowInRiyadh();
    if (hour < 8) adjustedDate.setDate(adjustedDate.getDate() - 1);

    const dateCol = findDateColumn(rawData[0], adjustedDate);
    if (dateCol === -1) return res.json({ time: '', activeShifts: [], employees: [] });

    const activeCodes = [];
    if (hour >= 23 || hour < 8) activeCodes.push('N');
    if (hour >= 8 && hour < 17) activeCodes.push('M');
    if (hour >= 15 && hour < 23) activeCodes.push('E');
    if (hour >= 12 && hour < 21) activeCodes.push('B');

    const { employeeStartRow, employeeEndRow } = config;
    const employees = [];
    for (let i = employeeStartRow; i <= Math.min(employeeEndRow, rawData.length - 1); i++) {
      const row = rawData[i];
      const name = (row[1] || '').toString().trim();
      if (!name) continue;
      const shift = parseShift(row[dateCol]);
      if (!shift) continue;
      if (activeCodes.includes(shift.code)) {
        employees.push({ name, shiftCode: shift.code, rawTime: shift.rawTime });
      }
    }

    const timeStr = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    res.json({
      time: timeStr,
      activeShifts: activeCodes, employees
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Salary API ---
app.get('/api/salary', (req, res) => {
  const { salaryDay } = config;
  const today = nowInRiyadh();
  const currentDay = today.getDate();
  const afterSalary = currentDay > salaryDay;
  const nextMonth = afterSalary ? today.getMonth() + 1 : today.getMonth();
  const nextYear = afterSalary && today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  const nextDate = new Date(nextYear, nextMonth, salaryDay);
  const diff = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
  const salaryStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
  res.json({ daysLeft: diff, salaryDate: salaryStr });
});

// Keep alive — ping self every 14 min to prevent Render free tier sleep
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    setInterval(() => {
      require('https').get(url, () => {}).on('error', () => {});
    }, 14 * 60 * 1000);
  }
}

// Connect to MongoDB at startup, then start server
getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
    keepAlive();
  });
}).catch(() => {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT} (no MongoDB)`);
    keepAlive();
  });
});

module.exports = app;
