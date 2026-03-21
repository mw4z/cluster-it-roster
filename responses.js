const config = require('./config');
const main = require('./main');

const { shiftMap, salaryDay } = config;

const responses = [
  {
    triggers: [
      "today roster", "who is working today", "who's on shift today", "today shift",
      "today shifts", "today's roster"
    ],
    type: "todayRoster"
  },
  {
    triggers: [
      "who is in the office", "who is at the office now", "anyone in office",
      "who's at work now", "who in duty now", "who is working now",
      "who in duty", "who is in duty", "who on duty", "who on duty now",
      "who is on duty", "who's in duty", "who's on duty", "who's in office"
    ],
    type: "officeNow"
  },
  {
    triggers: [
      "how many days till salary", "when is salary", "salary left",
      "salary countdown", "next salary"
    ],
    type: "salaryCountdown"
  },
  {
    triggers: [
      "how many days left in roster", "when does the schedule end", "roster end",
      "roster countdown"
    ],
    type: "rosterCountdown"
  },
  {
    triggers: [
      "tomorrow roster", "tomorrow's shifts", "who's working tomorrow",
      "next day roster"
    ],
    type: "tomorrowRoster"
  },
  {
    triggers: ["gboti"],
    type: "showMenu"
  }
];

function getResponseType(messageText) {
  const cleaned = messageText.toLowerCase().replace(/[^\w\s]/g, '').trim();
  for (const res of responses) {
    for (const trigger of res.triggers) {
      const cleanedTrigger = trigger.toLowerCase().replace(/[^\w\s]/g, '').trim();
      const regex = new RegExp(`\\b${cleanedTrigger}\\b`, 'i');
      if (regex.test(cleaned)) return res.type;
    }
  }
  return null;
}

function getAdjustedDateForShifts() {
  const now = new Date();
  if (now.getHours() < 8) now.setDate(now.getDate() - 1);
  return now;
}

// Determine which shift codes are currently active based on time of day
function getActiveShiftCodes() {
  const hour = new Date().getHours();
  const codes = [];
  if (hour >= 23 || hour < 8) codes.push('N');   // Night: 23:00 - 08:00
  if (hour >= 8 && hour < 17) codes.push('M');    // Morning: 08:00 - 17:00
  if (hour >= 15 && hour < 23) codes.push('E');   // Evening: 15:00 - 23:00
  if (hour >= 12 && hour < 21) codes.push('B');   // Between: 12:00 - 21:00
  return codes;
}

function getOfficeNowMessage() {
  const rawData = main.loadWorkbook();
  if (!rawData) return "❌ Shift file not found or could not be read.";

  const adjustedDate = getAdjustedDateForShifts();
  const dateCol = main.findDateColumn(rawData[0], adjustedDate);
  if (dateCol === -1) return "❌ Date column not found.";

  const activeShiftCodes = getActiveShiftCodes();
  const employees = [];

  const { employeeStartRow, employeeEndRow } = config;

  for (let i = employeeStartRow; i <= Math.min(employeeEndRow, rawData.length - 1); i++) {
    const row = rawData[i];
    const name = (row[1] || '').toString().trim();
    if (!name) continue;

    const shift = main.parseShift(row[dateCol]);
    if (!shift) continue;

    if (activeShiftCodes.includes(shift.code)) {
      let entry = name;
      if (shift.rawTime) entry += ` (${shift.rawTime})`;
      employees.push(entry);
    }
  }

  if (employees.length === 0) {
    return "👥 Currently no one is in the office based on the shift schedule.";
  }

  let msg = `🏢 *Currently in Office (${employees.length}):*\n\n`;
  msg += employees.map(n => `- ${n}`).join('\n');
  return msg;
}

function getSalaryCountdown() {
  const today = new Date();
  const currentDay = today.getDate();
  const afterSalary = currentDay > salaryDay;
  const nextMonth = afterSalary ? today.getMonth() + 1 : today.getMonth();
  const nextYear = afterSalary && today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  const nextDate = new Date(nextYear, nextMonth, salaryDay);
  const diff = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));
  return `*💰 ${diff} days left until salary*`;
}

function getRosterCountdown() {
  const rawData = main.loadWorkbook();
  if (!rawData) return "❌ Shift file not found or could not be read.";

  const today = new Date();
  const dateCells = rawData[0].slice(2);
  let remainingDays = 0;
  for (const cell of dateCells) {
    if (!cell) continue;
    const cellDate = main.parseCellDate(cell, today.getFullYear());
    if (cellDate && !isNaN(cellDate) && cellDate >= today) {
      remainingDays++;
    }
  }
  return `*📅 ${remainingDays} days left in the current roster*`;
}

async function getAutoResponse(text, client, msg, quoted) {
  const type = getResponseType(text);
  if (!type) return null;

  if (type === "todayRoster") return await main.getTodayRosterMessage(false);
  if (type === "tomorrowRoster") return await main.getTodayRosterMessage(false, true);
  if (type === "officeNow") return getOfficeNowMessage();
  if (type === "salaryCountdown") return getSalaryCountdown();
  if (type === "rosterCountdown") return getRosterCountdown();

  if (type === "showMenu") {
    const menuText = `
📋 *Menu:*

1️⃣ Today's Roster
2️⃣ Tomorrow's Roster
3️⃣ Who's in Office
4️⃣ Salary Countdown
5️⃣ Roster Countdown

Type a number to continue.`.trim();
    return {
      type: "menuOption",
      content: menuText
    };
  }

  return null;
}

module.exports = {
  getAutoResponse,
  getOfficeNowMessage,
  getSalaryCountdown,
  getRosterCountdown
};
