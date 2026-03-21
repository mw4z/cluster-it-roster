// index.js (WPPConnect)

const wppconnect = require('@wppconnect-team/wppconnect');
const schedule = require('node-schedule');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { getAutoResponse, getOfficeNowMessage, getSalaryCountdown, getRosterCountdown } = require('./responses');
const main = require('./main');

const { contactMap, sessionName, groupName, scheduleCron, stateCheckInterval } = config;
const logFile = path.join(__dirname, config.logFile);
const maxLogSizeBytes = config.maxLogSizeMB * 1024 * 1024;

// --- Log Rotation ---
function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= maxLogSizeBytes) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = logFile.replace('.txt', `_${timestamp}.txt`);
      fs.renameSync(logFile, rotatedFile);
      console.log(`Log rotated: ${rotatedFile}`);
    }
  } catch (e) {
    console.warn('Log rotation failed:', e.message);
  }
}

function appendLog(line) {
  rotateLogIfNeeded();
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {
    console.warn('Failed to write log:', e.message);
  }
}

// Start web dashboard
require('./server');

console.log('Starting WPPConnect bot...');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

wppconnect
  .create({
    session: sessionName,
    headless: true,
    browserArgs: ['--no-sandbox'],
    puppeteerOptions: { userDataDir: path.join(__dirname, 'user-data') },
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log('QR generated, scan to login. Attempts:', attempts);
      try { qrcode.generate(asciiQR || urlCode, { small: true }); } catch (e) {}
    }
  })
  .then(start)
  .catch((err) => console.error('WPPConnect create() failed:', err));

async function start(client) {
  console.log('Client created. Checking connection state...');

  // State monitoring
  setInterval(async () => {
    try {
      const ok = await client.isConnected();
      console.log('[STATE] isConnected =', ok);
    } catch (e) {
      console.log('[STATE] error:', e?.message || e);
    }
  }, stateCheckInterval);

  client.onStateChange((state) => {
    console.log('[STATE CHANGE]:', state);
  });

  // List groups on startup
  try {
    for (let i = 1; i <= 5; i++) {
      try {
        const chats = await client.getAllChats();
        const groups = chats.filter(c => c.isGroup);
        console.log('Groups count:', groups.length);
        break;
      } catch (e) {
        console.warn(`getAllChats failed (attempt ${i}/5):`, e?.message || e);
        await sleep(2000);
      }
    }
  } catch (e) {
    console.warn('Listing groups failed:', e?.message || e);
  }

  // Scheduled daily roster message
  console.log(`Scheduling "${scheduleCron}" job...`);
  schedule.scheduleJob(scheduleCron, async () => {
    console.log('[Scheduler] Triggered.');
    try {
      const message = await main.getTodayRosterMessage(true);

      let groupId = null;
      for (let i = 1; i <= 5; i++) {
        try {
          const chats = await client.getAllChats();
          const group = chats.find((c) => c.isGroup && c.name === groupName);
          if (group) { groupId = group.id._serialized || group.id; break; }
        } catch (e) {
          console.warn(`getAllChats error attempt ${i}:`, e?.message || e);
        }
        await sleep(2000);
      }

      if (!groupId) {
        console.error(`Group "${groupName}" not found.`);
        return;
      }

      await client.sendText(groupId, message);
      console.log('Scheduled message sent.');
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  // Log all messages (debug)
  client.onAnyMessage((m) => {
    console.log('[onAnyMessage] from:', m.from, '| body:', (m.body || '').substring(0, 50));
  });

  // Main message handler
  client.onMessage(async (message) => {
    // Quick test
    if ((message.body || '').trim().toLowerCase() === 'ping#') {
      await client.sendText(message.from, 'pong');
      return;
    }

    if (!message.body) return;

    // Log group messages
    if (message.isGroupMsg && message.author) {
      const senderName = message.sender?.pushname || 'Unknown';
      const number = message.sender?.id?.user || 'N/A';
      const logLine = `[${new Date().toISOString()}] Group: ${message.from} - Name: ${senderName} - Number: ${number} - ID: ${message.author}\n`;
      appendLog(logLine);
    }

    const lower = (message.body || '').toLowerCase().trim();

    // Menu number reply
    const numOptions = ['1', '2', '3', '4', '5'];
    const quotedBody = message.quotedMsg?.body || message.quotedMsgObj?.body || message.quotedMsg?.text || '';
    const isNumberReply = numOptions.includes(lower) && !!quotedBody && quotedBody.includes('Menu:');

    if (isNumberReply) {
      console.log(`Menu selection: ${lower}`);
      try {
        if (lower === '1') return await client.sendText(message.from, await main.getTodayRosterMessage(false));
        if (lower === '2') return await client.sendText(message.from, await main.getTodayRosterMessage(false, true));
        if (lower === '3') return await client.sendText(message.from, getOfficeNowMessage());
        if (lower === '4') return await client.sendText(message.from, getSalaryCountdown());
        if (lower === '5') return await client.sendText(message.from, getRosterCountdown());
      } catch (err) {
        console.error('Menu handler error:', err);
      }
      return;
    }

    // Auto responses
    try {
      const quoted = message.quotedMsg || message.quotedMsgObj || null;
      const resp = await getAutoResponse(lower, client, message, quoted);

      if (resp) {
        const senderId = message.author || message.from;
        const name = contactMap[senderId];
        const hour = new Date().getHours();
        const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
        const prefix = name ? `${greeting} ${name}\n\n` : '';

        if (typeof resp === 'string') {
          await client.sendText(message.from, prefix + resp);
        } else if (resp.type === 'menuOption') {
          await client.sendText(message.from, prefix + resp.content);
        }
      }
    } catch (err) {
      console.error('Error during auto-response:', err);
    }
  });
}
