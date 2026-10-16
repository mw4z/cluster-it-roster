require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

function loadContacts() {
  const file = path.join(__dirname, process.env.CONTACTS_FILE || 'contacts.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Failed to read contacts file:', e.message);
    return {};
  }
}

module.exports = {
  // Environment variables
  weatherApiKey: process.env.WEATHER_API_KEY,
  sessionName: process.env.SESSION_NAME || 'cluster-it-support',
  groupName: process.env.GROUP_NAME || 'Cluster IT Support',
  scheduleCron: process.env.SCHEDULE_CRON || '00 7 * * *',
  stateCheckInterval: parseInt(process.env.STATE_CHECK_INTERVAL) || 600000,
  logFile: process.env.LOG_FILE || 'group_id_log.txt',
  maxLogSizeMB: parseInt(process.env.MAX_LOG_SIZE_MB) || 5,

  // Contact mapping (WhatsApp sender ID -> { name, roster }) lives in contacts.json,
  // which is gitignored so phone numbers stay out of the repo. See contacts.example.json.
  contactMap: loadContacts(),

  // Shift code -> Display label with emoji
  shiftMap: {
    M: "🕘 Morning",
    B: "🟠 Between",
    E: "🌆 Evening",
    N: "🌙 Night",
    OFF: "🟨 Day Off",
    X: "🟪 Pending Off (Taken)",
    Z: "🔵 Pending Off (Actual)",
    PH: "🎉 Public Holiday",
    V: "🏖️ Annual Leave",
    NH: "🏳️ National Holiday",
    DL: "🖤 Bereavement Leave",
    S: "🤒 Sick Leave",
    T: "📋 Task Force",
    U: "⚪ Unpaid Vacation",
    EX: "📝 Exam Leave",
    PL: "🕐 Permission Leave",
    C: "👶 Child Leave",
    TR: "🎓 Training",
    OUTING: "🏕️ IT Outing"
  },

  // Display order for shifts in messages
  shiftOrder: [
    "🕘 Morning", "🟠 Between", "🌆 Evening", "🌙 Night",
    "📋 Task Force", "🎓 Training", "🏕️ IT Outing",
    "🟨 Day Off", "🟪 Pending Off (Taken)", "🔵 Pending Off (Actual)",
    "🤒 Sick Leave", "🖤 Bereavement Leave", "📝 Exam Leave",
    "🕐 Permission Leave", "👶 Child Leave", "⚪ Unpaid Vacation",
    "🏳️ National Holiday", "🎉 Public Holiday", "🏖️ Annual Leave"
  ],

  // In-charge priority (highest first). Names are matched ignoring case, commas and
  // word order, so "Hassan, Islam" matches "Islam Hassan" in the sheet.
  inChargePriority: [
    'Salem Seif',
    'Saad Marwan',
    'Mostafa Nabil',
    'Hassan, Islam',
    'Alamoudi, Abdulrhman',
    'Moayad Yar',
    'ziyad al zahrani',
    'Mohammed Alkhattabi',
    'Suhaib  Midrad',
    'Hatem Asim',
    'Yasser Mattiri',
    'Meshari Alharithi',
    'Abdulmajed Othman',
    'Haitham Sendi'
  ],

  // Salary day of the month
  salaryDay: parseInt(process.env.SALARY_DAY) || 27,

  // Working shifts that must have at least one person; empty ones are flagged as gaps
  requiredShifts: ['M', 'E', 'N'],

  // PIN for dashboard edits and roster uploads. Uploads are disabled until it is set.
  adminPin: process.env.ADMIN_PIN || '',

  // First employee row in Excel (0-based); employees run until the first blank name
  employeeStartRow: 2,

  // Day names
  daysEn: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

  // Classify a time-range shift string into a shift code
  classifyTimeShift(shiftStr) {
    const s = shiftStr.trim().toUpperCase();

    // Remove suffix flags first
    const clean = s.replace(/-?Z$/i, '').replace(/-?X$/i, '').trim();

    // If it's a known code directly, return it
    if (this.shiftMap[clean]) return clean;

    // Parse time ranges like "8:00 AM - 14:00 PM" or "11:00 PM - 08:00 AM"
    const timeMatch = clean.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!timeMatch) return null;

    const startHour = parseInt(timeMatch[1]);
    const startPeriod = timeMatch[3].toUpperCase();
    const endHour = parseInt(timeMatch[4]);
    const endPeriod = timeMatch[6].toUpperCase();

    // Convert to 24h
    let start24 = startHour;
    if (startPeriod === 'PM' && startHour < 12) start24 += 12;
    if (startPeriod === 'AM' && startHour === 12) start24 = 0;

    let end24 = endHour;
    if (endPeriod === 'PM' && endHour < 12) end24 += 12;
    if (endPeriod === 'AM' && endHour === 12) end24 = 0;

    // Classify based on start time
    if (start24 >= 18 || start24 < 4) return 'N';    // Night: starts 18:00-03:59 (e.g. 8:00 PM - 8:00 AM)
    if (start24 >= 6 && start24 < 10) return 'M';     // Morning: starts 06:00-09:59
    if (start24 >= 10 && start24 < 13) return 'B';    // Between: starts 10:00-12:59
    if (start24 >= 13 && start24 < 18) return 'E';    // Evening: starts 13:00-17:59

    return 'B'; // Default to Between
  }
};
