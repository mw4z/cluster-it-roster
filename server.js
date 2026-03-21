const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { loadWorkbook, findDateColumn, parseShift, parseCellDate } = require('./main');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Daily Data (Occupancy + In-Charge) ---
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// GET daily data for a date
app.get('/api/daily-data', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date required' });
  const all = loadData();
  res.json(all[date] || { occupancy: {}, inCharge: {} });
});

// POST save daily data for a date
app.post('/api/daily-data', (req, res) => {
  const { date, occupancy, inCharge } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  const all = loadData();
  all[date] = { occupancy: occupancy || {}, inCharge: inCharge || {} };
  saveData(all);
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

    const availableDates = [];
    for (let i = 2; i < firstRow.length; i++) {
      const cellDate = parseCellDate(firstRow[i], dt.getFullYear());
      if (cellDate && !isNaN(cellDate)) {
        const y = cellDate.getUTCFullYear();
        const m = String(cellDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(cellDate.getUTCDate()).padStart(2, '0');
        availableDates.push(`${y}-${m}-${d}`);
      }
    }

    if (dateCol === -1) {
      return res.json({
        date: dt.toISOString().split('T')[0],
        dayName: daysEn[dt.getDay()],
        dateFormatted: dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        isEid: false, shifts: [], availableDates, notFound: true
      });
    }

    const headerCell = (firstRow[dateCol] || '').toString();
    const isEid = /eid/i.test(headerCell);

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
      date: dt.toISOString().split('T')[0],
      dayName: daysEn[dt.getDay()],
      dateFormatted: dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
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

    const now = new Date();
    const hour = now.getHours();
    const adjustedDate = new Date();
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

    res.json({
      time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
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
  const today = new Date();
  const currentDay = today.getDate();
  const afterSalary = currentDay > salaryDay;
  const nextMonth = afterSalary ? today.getMonth() + 1 : today.getMonth();
  const nextYear = afterSalary && today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  const nextDate = new Date(nextYear, nextMonth, salaryDay);
  const diff = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
  const salaryStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
  res.json({ daysLeft: diff, salaryDate: salaryStr });
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

module.exports = app;
