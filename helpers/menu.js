// helpers/menu.js

function buildMenuButtons(lang = 'en') {

  if (lang === 'ar') {

    return {

      title: '📋 القائمة',

      text: 'اختر خيارًا:',

      buttons: [

        { buttonId: 'menu_1', buttonText: { displayText: '1️⃣ روستر اليوم' }, type: 1 },

        { buttonId: 'menu_2', buttonText: { displayText: '2️⃣ روستر بكرة' }, type: 1 },

        { buttonId: 'menu_3', buttonText: { displayText: '3️⃣ مين بالمكتب الآن' }, type: 1 },

        { buttonId: 'menu_4', buttonText: { displayText: '4️⃣ عدّاد الراتب' }, type: 1 },

        { buttonId: 'menu_5', buttonText: { displayText: '5️⃣ عدّاد الروستر' }, type: 1 },

      ]

    };

  }

  // EN

  return {

    title: '📋 Menu',

    text: 'Choose an option:',

    buttons: [

      { buttonId: 'menu_1', buttonText: { displayText: "1️⃣ Today's Roster" }, type: 1 },

      { buttonId: 'menu_2', buttonText: { displayText: "2️⃣ Tomorrow's Roster" }, type: 1 },

      { buttonId: 'menu_3', buttonText: { displayText: "3️⃣ Who's in Office" }, type: 1 },

      { buttonId: 'menu_4', buttonText: { displayText: '4️⃣ Salary Countdown' }, type: 1 },

      { buttonId: 'menu_5', buttonText: { displayText: '5️⃣ Roster Countdown' }, type: 1 },

    ]

  };

}

async function sendMenu(client, chatId, lang = 'en') {

  const m = buildMenuButtons(lang);

  // sendButtons(chatId, bodyText, buttons[], title)

  await client.sendButtons(chatId, m.text, m.buttons, m.title);

}

module.exports = { sendMenu };
 