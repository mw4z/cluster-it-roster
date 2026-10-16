const config = require('./config');
const main = require('./main');
const roster = require('./roster');

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
    triggers: ["my shift", "my shifts", "my schedule", "my roster", "when do i work"],
    type: "mySchedule"
  },
  {
    triggers: ["gboti"],
    type: "showMenu"
  }
];

const MENU_TEXT = `
📋 *Menu:*

1️⃣ Today's Roster
2️⃣ Tomorrow's Roster
3️⃣ Who's in Office
4️⃣ Salary Countdown
5️⃣ Roster Countdown
6️⃣ My Schedule (next 7 days)

Type a number to continue.`.trim();

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

function getOfficeNowMessage() {
  const data = roster.getRoster();
  if (!data) return "❌ Shift file not found or could not be read.";

  const now = roster.officeNow(data);
  if (!now.employees.length) {
    return "👥 Currently no one is in the office based on the shift schedule.";
  }
  const lines = now.employees.map(e => {
    let s = `- ${e.name} — ${e.label}`;
    if (e.rawTime) s += ` (${e.rawTime})`;
    return s;
  });
  return `🏢 *Currently in Office (${now.employees.length}) — ${now.time}:*\n\n` + lines.join('\n');
}

function getSalaryCountdown() {
  const s = roster.salaryInfo();
  return `*💰 ${main.formatEnglishDays(s.daysLeft)} left until salary* (${roster.formatKey(s.salaryDate)})`;
}

function getRosterCountdown() {
  const rc = roster.rosterCountdown();
  if (!rc) return "❌ Shift file not found or could not be read.";
  if (rc.ended) return `*📅 The current roster ended on ${roster.formatKey(rc.end)}* — waiting for the next one.`;
  return `*📅 ${main.formatEnglishDays(rc.daysLeft)} left in the current roster* (ends ${roster.formatKey(rc.end)})`;
}

function getMySchedule(senderId) {
  const contact = config.contactMap[senderId];
  const rosterName = contact && (contact.roster || contact.name);
  if (!rosterName) return "🤷 I don't know who you are yet — ask the admin to add you to contacts.json.";
  return main.getMyScheduleMessage(rosterName)
    || `🤷 Couldn't find "${rosterName}" in the roster.`;
}

// Handles a menu number. Returns the reply text or null.
async function getMenuReply(choice, senderId) {
  switch (choice) {
    case '1': return main.getTodayRosterMessage(false);
    case '2': return main.getTodayRosterMessage(false, true);
    case '3': return getOfficeNowMessage();
    case '4': return getSalaryCountdown();
    case '5': return getRosterCountdown();
    case '6': return getMySchedule(senderId);
    default: return null;
  }
}

async function getAutoResponse(text, client, msg) {
  const type = getResponseType(text);
  if (!type) return null;

  const senderId = msg ? (msg.author || msg.from) : null;
  if (type === "todayRoster") return main.getTodayRosterMessage(false);
  if (type === "tomorrowRoster") return main.getTodayRosterMessage(false, true);
  if (type === "officeNow") return getOfficeNowMessage();
  if (type === "salaryCountdown") return getSalaryCountdown();
  if (type === "rosterCountdown") return getRosterCountdown();
  if (type === "mySchedule") return getMySchedule(senderId);
  if (type === "showMenu") return { type: "menuOption", content: MENU_TEXT };
  return null;
}

module.exports = {
  getAutoResponse,
  getMenuReply,
  getOfficeNowMessage,
  getSalaryCountdown,
  getRosterCountdown,
  getMySchedule
};
