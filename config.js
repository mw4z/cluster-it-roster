require('dotenv').config();

module.exports = {
  // Environment variables
  weatherApiKey: process.env.WEATHER_API_KEY,
  sessionName: process.env.SESSION_NAME || 'cluster-it-support',
  groupName: process.env.GROUP_NAME || 'Cluster IT Support',
  scheduleCron: process.env.SCHEDULE_CRON || '00 7 * * *',
  stateCheckInterval: parseInt(process.env.STATE_CHECK_INTERVAL) || 600000,
  logFile: process.env.LOG_FILE || 'group_id_log.txt',
  maxLogSizeMB: parseInt(process.env.MAX_LOG_SIZE_MB) || 5,

  // Contact mapping (sender ID -> display name)
  contactMap: {
    "966564375970@c.us": "Moayad",
    "100085790691386@lid": "Moayad",
    "966545431283@c.us": "Suhaib",
    "8100442591323@lid": "Suhaib",
    "966562189556@c.us": "Mostafa",
    "143104183128090@lid": "Mostafa",
    "966559283543@c.us": "Hatem",
    "253364583579767@lid": "Hatem",
    "966557894775@c.us": "Ziyad",
    "102898876862663@lid": "Ziyad",
    "966549991323@c.us": "Islam",
    "201150867476531@lid": "Islam",
    "966562375066@c.us": "Abdulrahman",
    "51793195172054@lid": "Abdulrahman",
    "966550507006@c.us": "Abdulrahman",
    "117536125382671@lid": "Abdulrahman",
    "966500500904@c.us": "Saad",
    "219378389889192@lid": "Saad",
    "966566678555@c.us": "Mohammed",
    "100214539088109@lid": "Mohammed",
    "966540317709@c.us": "Mahmoud",
    "412451127495@lid": "Mahmoud",
    "966546259914@c.us": "Shakeel",
    "101142235242714@lid": "Shakeel",
    "966569614802@c.us": "Kashif",
    "133019700572227@lid": "Kashif",
    "966540880234@c.us": "Khalid",
    "36962589274185@lid": "Khalid",
    "966545915322@c.us": "Salim",
    "228969253199873@lid": "Salim",
    "966551839959@c.us": "Meshari",
    "184902670647356@lid": "Meshari",
    "966549597890@c.us": "Abdulmajeed",
    "134514114334927@lid": "Abdulmajeed",
    "966567665243@c.us": "Haitham",
    "153021128384608@lid": "Haitham"
  },

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
    TR: "🎓 Training"
  },

  // Display order for shifts in messages
  shiftOrder: [
    "🕘 Morning", "🟠 Between", "🌆 Evening", "🌙 Night",
    "📋 Task Force", "🎓 Training",
    "🟨 Day Off", "🟪 Pending Off (Taken)", "🔵 Pending Off (Actual)",
    "🤒 Sick Leave", "🖤 Bereavement Leave", "📝 Exam Leave",
    "🕐 Permission Leave", "👶 Child Leave", "⚪ Unpaid Vacation",
    "🏳️ National Holiday", "🎉 Public Holiday", "🏖️ Annual Leave"
  ],

  // In-charge priority (highest first)
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
    'Abdulmajeed Othman',
    'Haitham Sendi'
  ],

  // Salary day (27th of every month)
  salaryDay: 27,

  // Employee data rows in Excel (first employee row, last employee row)
  employeeStartRow: 2,
  employeeEndRow: 17,

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
    if (start24 >= 22 || start24 < 4) return 'N';    // Night: starts 22:00-03:59
    if (start24 >= 6 && start24 < 10) return 'M';     // Morning: starts 06:00-09:59
    if (start24 >= 10 && start24 < 13) return 'B';    // Between: starts 10:00-12:59
    if (start24 >= 13 && start24 < 18) return 'E';    // Evening: starts 13:00-17:59

    return 'B'; // Default to Between
  }
};
