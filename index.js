require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// ── Database ──────────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
const adapter = new FileSync('./data/db.json');
const db = low(adapter);
db.defaults({ users: [], transactions: [], sessions: [], channels: [] }).write();
console.log('✅ Database ready');

// ── DB Helpers ────────────────────────────────────────────────────────────────
const getUser = (id) => db.get('users').find({ telegram_id: String(id) }).value();
const getUserByUsername = (u) => db.get('users').find({ telegram_username: u }).value();
const getUserByPhone = (p) => db.get('users').find({ phone_number: p }).value();

const upsertUser = (id, username, name) => {
  const existing = getUser(id);
  if (existing) {
    db.get('users').find({ telegram_id: String(id) })
      .assign({ telegram_username: username||null, full_name: name||null }).write();
  } else {
    db.get('users').push({ telegram_id: String(id), telegram_username: username||null,
      full_name: name||null, phone_number: null, created_at: new Date().toISOString() }).write();
  }
  return getUser(id);
};

const setPhone = (id, phone) => {
  db.get('users').find({ telegram_id: String(id) }).assign({ phone_number: phone }).write();
};

const getSession = (id) => db.get('sessions').find({ telegram_id: String(id) }).value();
const setSession = (id, step, data={}) => {
  const existing = getSession(id);
  if (existing) {
    db.get('sessions').find({ telegram_id: String(id) }).assign({ step, data }).write();
  } else {
    db.get('sessions').push({ telegram_id: String(id), step, data }).write();
  }
};
const clearSession = (id) => {
  db.get('sessions').remove({ telegram_id: String(id) }).write();
};

const saveTx = (f) => {
  db.get('transactions').push({
    reference_id: f.ref, type: f.type, status: f.status||'pending',
    sender_id: f.senderId||null, recipient_phone: f.phone,
    amount: f.amount, description: f.desc||null,
    created_at: new Date().toISOString()
  }).write();
};
const updateTx = (ref, status) => {
  db.get('transactions').find({ reference_id: ref }).assign({ status }).write();
};
const getTxHistory = (id) => {
  return db.get('transactions').filter({ sender_id: String(id) })
    .sortBy('created_at').reverse().take(10).value();
};

const getChannel = (id) => db.get('channels').find({ channel_id: String(id) }).value();
const saveChannel = (id, name, adminId, phone) => {
  const existing = getChannel(id);
  if (existing) {
    db.get('channels').find({ channel_id: String(id) })
      .assign({ channel_name: name, admin_phone: phone }).write();
  } else {
    db.get('channels').push({ channel_id: String(id), channel_name: name,
      admin_id: String(adminId), admin_phone: phone }).write();
  }
};

// ── MTN MoMo API ──────────────────────────────────────────────────────────────
const BASE = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
const ENV = process.env.MOMO_TARGET_ENVIRONMENT || 'sandbox';
const CURRENCY = process.env.MOMO_CURRENCY || 'EUR';
const tokenCache = {};

async function getToken(product) {
  const c = tokenCache[product];
  if (c && c.exp > Date.now() + 30000) return c.token;
  const userId = product === 'collection' ? process.env.MOMO_COLLECTIONS_USER_ID : process.env.MOMO_DISBURSEMENTS_USER_ID;
  const apiKey = product === 'collection' ? process.env.MOMO_COLLECTIONS_API_KEY : process.env.MOMO_DISBURSEMENTS_API_KEY;
  const primaryKey = product === 'collection' ? process.env.MOMO_COLLECTIONS_PRIMARY_KEY : process.env.MOMO_DISBURSEMENTS_PRIMARY_KEY;
  const res = await axios.post(`${BASE}/${product}/token/`, {}, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${userId}:${apiKey}`).toString('base64')}`,
      'Ocp-Apim-Subscription-Key': primaryKey
    }
  });
  tokenCache[product] = { token: res.data.access_token, exp: Date.now() + res.data.expires_in * 1000 };
  return tokenCache[product].token;
}

const normalizePhone = (p) => p.replace(/^\+/, '').replace(/^0/, '256');

async function requestToPay(amount, phone, desc, ref) {
  const token = await getToken('collection');
  await axios.post(`${BASE}/collection/v1_0/requesttopay`, {
    amount: String(amount), currency: CURRENCY, externalId: ref,
    payer: { partyIdType: 'MSISDN', partyId: normalizePhone(phone) },
    payerMessage: desc||'Telegram payment', payeeNote: desc||'MoMo Bot'
  }, {
    headers: {
      Authorization: `Bearer ${token}`, 'X-Reference-Id': ref,
      'X-Target-Environment': ENV,
      'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTIONS_PRIMARY_KEY,
      'Content-Type': 'application/json'
    }
  });
}

async function checkPayment(ref) {
  const token = await getToken('collection');
  const res = await axios.get(`${BASE}/collection/v1_0/requesttopay/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`, 'X-Target-Environment': ENV,
      'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTIONS_PRIMARY_KEY
    }
  });
  return res.data;
}

async function sendMoney(amount, phone, desc, ref) {
  const token = await getToken('disbursement');
  await axios.post(`${BASE}/disbursement/v1_0/transfer`, {
    amount: String(amount), currency: CURRENCY, externalId: ref,
    payee: { partyIdType: 'MSISDN', partyId: normalizePhone(phone) },
    payerMessage: desc||'Telegram transfer', payeeNote: desc||'MoMo Bot'
  }, {
    headers: {
      Authorization: `Bearer ${token}`, 'X-Reference-Id': ref,
      'X-Target-Environment': ENV,
      'Ocp-Apim-Subscription-Key': process.env.MOMO_DISBURSEMENTS_PRIMARY_KEY,
      'Content-Type': 'application/json'
    }
  });
}

async function getBalance() {
  const token = await getToken('collection');
  const res = await axios.get(`${BASE}/collection/v1_0/account/balance`, {
    headers: {
      Authorization: `Bearer ${token}`, 'X-Target-Environment': ENV,
      'Ocp-Apim-Subscription-Key': process.env.MOMO_COLLECTIONS_PRIMARY_KEY
    }
  });
  return res.data;
}

async function pollStatus(ref, tries=24, interval=5000) {
  for (let i=0; i<tries; i++) {
    await new Promise(r => setTimeout(r, interval));
    const result = await checkPayment(ref);
    if (result.status !== 'PENDING') return result;
  }
  return { status: 'FAILED', reason: 'Timeout' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (amount, currency=CURRENCY) => `${currency} ${Number(amount).toFixed(2)}`;
const isValidPhone = (p) => /^(\+?256|0)\d{9}$/.test(p.trim());
const cleanPhone = (p) => p.trim().replace(/[\s\-]/g, '');

// ── Bot Setup ─────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT||'3000', 10);
let bot;

if (WEBHOOK_URL) {
  bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });
  const app = express();
  app.use(express.json());
  const webhookPath = `/webhook/${TOKEN}`;
  app.post(webhookPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  app.get('/health', (_, res) => res.json({ status: 'ok' }));
  app.listen(PORT, async () => {
    await bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`);
    console.log(`✅ Webhook: ${WEBHOOK_URL}${webhookPath}`);
  });
} else {
  bot = new TelegramBot(TOKEN, { polling: true });
  console.log('✅ Polling mode');
}

// Auto-register every user
bot.on('message', async (msg) => {
  if (!msg.from) return;
  const { id, username, first_name, last_name } = msg.from;
  upsertUser(id, username, [first_name, last_name].filter(Boolean).join(' '));
});

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = getUser(msg.from.id);
  const deepLink = match[1];

  if (deepLink && deepLink.startsWith('pay_channel_')) {
    const parts = deepLink.split('_');
    const channelId = parts[2];
    const amount = parseFloat(parts[3]);
    const channel = getChannel(channelId);
    if (!channel) return bot.sendMessage(chatId, '❌ Payment link no longer valid.');
    if (!user?.phone_number) return bot.sendMessage(chatId, '❌ Link your MoMo number first.\n/register');
    return bot.sendMessage(chatId,
      `💳 *Channel Payment*\n\nChannel: ${channel.channel_name}\nAmount: *${fmt(amount)}*\nYour number: \`${user.phone_number}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: `✅ Pay ${fmt(amount)}`, callback_data: `chanpay:${channelId}:${amount}` },
        { text: '❌ Cancel', callback_data: 'cancel' }
      ]]}});
  }

  bot.sendMessage(chatId,
    `👋 Welcome to *MTN MoMo Bot*!\n\n` +
    (user?.phone_number ? `📱 Linked: \`${user.phone_number}\`\n\n` : `⚠️ No number linked. Use /register\n\n`) +
    `*Commands:*\n/register — link your MoMo number\n/pay — send money\n/request — request payment\n` +
    `/balance — check balance\n/history — transactions\n/connect — add to your channel\n/post — post paywall`,
    { parse_mode: 'Markdown' });
});

// ── /register ─────────────────────────────────────────────────────────────────
bot.onText(/\/register/, (msg) => {
  setSession(msg.from.id, 'awaiting_phone');
  bot.sendMessage(msg.chat.id,
    `📱 Send your MTN MoMo number:\nExample: \`+256700000000\`\n\n_Send /cancel to abort._`,
    { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, (msg) => {
  clearSession(msg.from.id);
  bot.sendMessage(msg.chat.id, '❎ Cancelled.');
});

// ── /balance ──────────────────────────────────────────────────────────────────
bot.onText(/\/balance/, async (msg) => {
  const user = getUser(msg.from.id);
  if (!user?.phone_number) return bot.sendMessage(msg.chat.id, '❌ Link your number first. /register');
  try {
    const bal = await getBalance();
    bot.sendMessage(msg.chat.id,
      `💳 *Balance*\n\n*${fmt(bal.availableBalance, bal.currency)}*\nLinked: \`${user.phone_number}\``,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(msg.chat.id, '❌ Could not get balance. Try again later.');
  }
});

// ── /history ──────────────────────────────────────────────────────────────────
bot.onText(/\/history/, (msg) => {
  const txs = getTxHistory(msg.from.id);
  if (!txs.length) return bot.sendMessage(msg.chat.id, '📭 No transactions yet.');
  const lines = txs.map(t =>
    `${t.status==='successful'?'✅':'❌'} ${fmt(t.amount)} → ${t.recipient_phone}\n   ${t.created_at.split('T')[0]}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `📜 *Recent Transactions*\n\n${lines}`, { parse_mode: 'Markdown' });
});

// ── /pay ──────────────────────────────────────────────────────────────────────
bot.onText(/\/pay(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = getUser(msg.from.id);
  if (!user?.phone_number) return bot.sendMessage(chatId, '❌ Link your number first. /register');
  if (!match[1]) return bot.sendMessage(chatId, '*Usage:*\n/pay @username 5000\n/pay +256700000000 5000', { parse_mode: 'Markdown' });

  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Include target and amount.');
  const target = parts[0];
  const amount = parseFloat(parts[1]);
  const desc = parts.slice(2).join(' ') || null;
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount.');

  let recipientPhone, recipientUser;
  if (target.startsWith('@')) {
    recipientUser = getUserByUsername(target.slice(1));
    if (!recipientUser?.phone_number) return bot.sendMessage(chatId, `❌ ${target} hasn't linked their MoMo number.`);
    recipientPhone = recipientUser.phone_number;
  } else {
    recipientPhone = cleanPhone(target);
    if (!isValidPhone(recipientPhone)) return bot.sendMessage(chatId, '❌ Invalid phone number.');
    recipientUser = getUserByPhone(recipientPhone);
  }

  const label = recipientUser
    ? `@${recipientUser.telegram_username||recipientUser.full_name} (${recipientPhone})`
    : recipientPhone;

  bot.sendMessage(chatId,
    `💸 *Confirm Payment*\n\nTo: ${label}\nAmount: *${fmt(amount)}*${desc?'\nMemo: '+desc:''}\nFrom: \`${user.phone_number}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: `payconfirm:${amount}:${recipientPhone}:${desc||''}` },
      { text: '❌ Cancel', callback_data: 'cancel' }
    ]]}});
});

// ── /request ──────────────────────────────────────────────────────────────────
bot.onText(/\/request(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = getUser(msg.from.id);
  if (!user?.phone_number) return bot.sendMessage(chatId, '❌ Link your number first. /register');
  if (!match[1]) return bot.sendMessage(chatId, '*Usage:*\n/request @username 5000\n/request +256700000000 5000', { parse_mode: 'Markdown' });

  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Include target and amount.');
  const target = parts[0];
  const amount = parseFloat(parts[1]);
  const desc = parts.slice(2).join(' ') || null;
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount.');

  let payerPhone, payerUser;
  if (target.startsWith('@')) {
    payerUser = getUserByUsername(target.slice(1));
    if (!payerUser?.phone_number) return bot.sendMessage(chatId, `❌ ${target} hasn't linked their MoMo number.`);
    payerPhone = payerUser.phone_number;
  } else {
    payerPhone = cleanPhone(target);
    if (!isValidPhone(payerPhone)) return bot.sendMessage(chatId, '❌ Invalid phone number.');
    payerUser = getUserByPhone(payerPhone);
  }

  const ref = uuidv4();
  if (payerUser) {
    await bot.sendMessage(payerUser.telegram_id,
      `💸 *Payment Request*\n\n${user.telegram_username?'@'+user.telegram_username:user.full_name} requests *${fmt(amount)}* from you.${desc?'\nMemo: '+desc:''}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: `✅ Pay ${fmt(amount)}`, callback_data: `reqpay:${ref}:${amount}:${payerPhone}:${user.telegram_id}` },
        { text: '❌ Decline', callback_data: `reqdecline:${user.telegram_id}` }
      ]]}}).catch(() => {});
    bot.sendMessage(chatId, `✅ Request sent to ${target} for *${fmt(amount)}*`, { parse_mode: 'Markdown' });
  } else {
    try {
      await bot.sendMessage(chatId, `📲 Sending USSD prompt to \`${payerPhone}\`…`, { parse_mode: 'Markdown' });
      await requestToPay(amount, payerPhone, desc||`Payment to ${user.phone_number}`, ref);
      saveTx({ ref, type: 'request', senderId: msg.from.id, phone: payerPhone, amount, desc });
      const result = await pollStatus(ref);
      if (result.status === 'SUCCESSFUL') {
        updateTx(ref, 'successful');
        bot.sendMessage(chatId, `💰 *Payment received!* ${fmt(amount)} from \`${payerPhone}\``, { parse_mode: 'Markdown' });
      } else {
        updateTx(ref, 'failed');
        bot.sendMessage(chatId, '❌ Payment not completed.');
      }
    } catch(e) {
      bot.sendMessage(chatId, `❌ Error: ${e.response?.data?.message||e.message}`);
    }
  }
});

// ── /connect ──────────────────────────────────────────────────────────────────
bot.onText(/\/connect/, (msg) => {
  const user = getUser(msg.from.id);
  if (!user?.phone_number) return bot.sendMessage(msg.chat.id, '❌ Link your number first. /register');
  setSession(msg.from.id, 'awaiting_channel');
  bot.sendMessage(msg.chat.id,
    `📢 *Connect Your Channel*\n\n1. Add me as admin of your channel\n2. Send your channel username e.g. \`@mychannel\`\n\nPayments will go to: \`${user.phone_number}\``,
    { parse_mode: 'Markdown' });
});

// ── /post ─────────────────────────────────────────────────────────────────────
bot.onText(/\/post(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = getUser(msg.from.id);
  if (!user?.phone_number) return bot.sendMessage(chatId, '❌ Link your number first. /register');
  if (!match[1]) return bot.sendMessage(chatId, '*Usage:*\n/post @channel 5000 Description', { parse_mode: 'Markdown' });

  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 3) return bot.sendMessage(chatId, '❌ Include channel, amount and description.');
  const channelUsername = parts[0].startsWith('@') ? parts[0] : `@${parts[0]}`;
  const amount = parseFloat(parts[1]);
  const desc = parts.slice(2).join(' ');
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount.');

  try {
    const chat = await bot.getChat(channelUsername);
    const channel = getChannel(String(chat.id));
    if (!channel) return bot.sendMessage(chatId, '❌ Channel not connected. Use /connect first.');
    if (String(channel.admin_id) !== String(msg.from.id)) return bot.sendMessage(chatId, '❌ You are not the admin of this channel.');
    await bot.sendMessage(chat.id,
      `🔒 *Premium Content*\n\n${desc}\n\n💰 Price: *${fmt(amount)}*\n\n_Tap below to pay and get access_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: `💳 Pay ${fmt(amount)}`, url: `https://t.me/${process.env.BOT_USERNAME}?start=pay_channel_${chat.id}_${amount}` }
      ]]}});
    bot.sendMessage(chatId, `✅ Posted to ${channelUsername}!`);
  } catch(e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// ── Text message handler ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const telegramId = msg.from.id;
  const session = getSession(telegramId);
  if (!session) return;

  if (session.step === 'awaiting_phone') {
    const phone = cleanPhone(msg.text);
    if (!isValidPhone(phone)) return bot.sendMessage(msg.chat.id, '❌ Invalid number. Try: `+256700000000`', { parse_mode: 'Markdown' });
    const existing = getUserByPhone(phone);
    if (existing && String(existing.telegram_id) !== String(telegramId)) return bot.sendMessage(msg.chat.id, '❌ Number already linked to another account.');
    setPhone(telegramId, phone);
    clearSession(telegramId);
    return bot.sendMessage(msg.chat.id, `✅ *Number linked!*\n\`${phone}\` is now your MoMo number.`, { parse_mode: 'Markdown' });
  }

  if (session.step === 'awaiting_channel') {
    const user = getUser(telegramId);
    const channelUsername = msg.text.trim().startsWith('@') ? msg.text.trim() : `@${msg.text.trim()}`;
    try {
      const chat = await bot.getChat(channelUsername);
      const admins = await bot.getChatAdministrators(chat.id);
      const isAdmin = admins.some(a => a.user.id === telegramId);
      const botIsAdmin = admins.some(a => a.user.is_bot && a.user.username === process.env.BOT_USERNAME);
      if (!isAdmin) return bot.sendMessage(msg.chat.id, `❌ You are not an admin of ${channelUsername}.`);
      if (!botIsAdmin) return bot.sendMessage(msg.chat.id, `❌ Add @${process.env.BOT_USERNAME} as admin first.`);
      saveChannel(String(chat.id), chat.title||channelUsername, telegramId, user.phone_number);
      clearSession(telegramId);
      bot.sendMessage(msg.chat.id,
        `✅ *${chat.title||channelUsername} connected!*\n\nPayments go to: \`${user.phone_number}\`\n\nPost paywall:\n/post ${channelUsername} 5000 Your content description`,
        { parse_mode: 'Markdown' });
    } catch(e) {
      bot.sendMessage(msg.chat.id, '❌ Could not find channel. Make sure I am an admin.');
    }
  }
});

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const telegramId = query.from.id;
  const user = getUser(telegramId);

  if (data === 'cancel') {
    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText('❎ Cancelled.', { chat_id: chatId, message_id: msgId });
  }

  if (data.startsWith('payconfirm:')) {
    const [, amount, recipientPhone, desc] = data.split(':');
    if (!user?.phone_number) return bot.answerCallbackQuery(query.id, { text: 'Link your number first.' });
    await bot.answerCallbackQuery(query.id, { text: 'Processing...' });
    await bot.editMessageText('⏳ Sending USSD prompt to your phone…', { chat_id: chatId, message_id: msgId });
    const ref = uuidv4();
    try {
      await requestToPay(amount, user.phone_number, desc||'Telegram payment', ref);
      saveTx({ ref, type: 'payment', senderId: telegramId, phone: recipientPhone, amount: parseFloat(amount), desc });
      await bot.sendMessage(chatId, `📲 Check \`${user.phone_number}\` for USSD prompt.\n_Waiting for approval…_`, { parse_mode: 'Markdown' });
      const result = await pollStatus(ref);
      if (result.status === 'SUCCESSFUL') {
        updateTx(ref, 'successful');
        const disbRef = uuidv4();
        await sendMoney(amount, recipientPhone, desc||'Telegram payment', disbRef);
        await bot.sendMessage(chatId, `✅ *Payment sent!*\n${fmt(amount)} → \`${recipientPhone}\`\nRef: \`${ref}\``, { parse_mode: 'Markdown' });
        const recipient = getUserByPhone(recipientPhone);
        if (recipient) bot.sendMessage(recipient.telegram_id,
          `💰 You received *${fmt(amount)}* from ${user.telegram_username?'@'+user.telegram_username:user.full_name}!`,
          { parse_mode: 'Markdown' }).catch(() => {});
      } else {
        updateTx(ref, 'failed');
        bot.sendMessage(chatId, '❌ Payment failed or not approved. No money deducted.');
      }
    } catch(e) {
      console.error(e.response?.data||e.message);
      bot.sendMessage(chatId, `❌ Error: ${e.response?.data?.message||e.message}`);
    }
  }

  if (data.startsWith('reqpay:')) {
    const [, ref, amount, payerPhone, requesterId] = data.split(':');
    if (!user?.phone_number) return bot.answerCallbackQuery(query.id, { text: 'Link your number first.' });
    await bot.answerCallbackQuery(query.id, { text: 'Sending USSD prompt...' });
    await bot.editMessageText('📲 Check your phone for USSD prompt…', { chat_id: chatId, message_id: msgId });
    try {
      await requestToPay(amount, user.phone_number, 'Payment request', ref);
      saveTx({ ref, type: 'request', senderId: requesterId, phone: payerPhone, amount: parseFloat(amount) });
      const result = await pollStatus(ref);
      if (result.status === 'SUCCESSFUL') {
        updateTx(ref, 'successful');
        bot.sendMessage(chatId, `✅ *Paid!* ${fmt(amount)} sent.`, { parse_mode: 'Markdown' });
        bot.sendMessage(requesterId,
          `💰 *Payment received!* ${fmt(amount)} from ${user.telegram_username?'@'+user.telegram_username:user.full_name}`,
          { parse_mode: 'Markdown' }).catch(() => {});
      } else {
        bot.sendMessage(chatId, '❌ Payment not completed.');
      }
    } catch(e) {
      bot.sendMessage(chatId, `❌ Error: ${e.response?.data?.message||e.message}`);
    }
  }

  if (data.startsWith('reqdecline:')) {
    const requesterId = data.split(':')[1];
    await bot.answerCallbackQuery(query.id);
    bot.editMessageText('❌ You declined this payment request.', { chat_id: chatId, message_id: msgId });
    bot.sendMessage(requesterId, '❌ Your payment request was declined.').catch(() => {});
  }

  if (data.startsWith('chanpay:')) {
    const [, channelId, amount] = data.split(':');
    if (!user?.phone_number) return bot.answerCallbackQuery(query.id, { text: 'Link your number first.' });
    const channel = getChannel(channelId);
    if (!channel) return bot.answerCallbackQuery(query.id, { text: 'Channel not found.' });
    await bot.answerCallbackQuery(query.id, { text: 'Sending USSD prompt...' });
    await bot.editMessageText('📲 Check your phone for USSD prompt…', { chat_id: chatId, message_id: msgId });
    const ref = uuidv4();
    try {
      await requestToPay(amount, user.phone_number, `Payment to ${channel.channel_name}`, ref);
      saveTx({ ref, type: 'channel_payment', senderId: telegramId, phone: channel.admin_phone, amount: parseFloat(amount) });
      const result = await pollStatus(ref);
      if (result.status === 'SUCCESSFUL') {
        updateTx(ref, 'successful');
        const disbRef = uuidv4();
        await sendMoney(amount, channel.admin_phone, 'Channel payment', disbRef);
        bot.sendMessage(chatId, `✅ *Payment successful!*\n${fmt(amount)} paid to *${channel.channel_name}*`, { parse_mode: 'Markdown' });
        bot.sendMessage(channel.admin_id,
          `💰 New payment! ${fmt(amount)} from ${user.telegram_username?'@'+user.telegram_username:user.full_name}`,
          { parse_mode: 'Markdown' }).catch(() => {});
      } else {
        updateTx(ref, 'failed');
        bot.sendMessage(chatId, '❌ Payment failed. Try again.');
      }
    } catch(e) {
      bot.sendMessage(chatId, `❌ Error: ${e.response?.data?.message||e.message}`);
    }
  }
});

bot.on('polling_error', (e) => console.error('Polling error:', e.message));
bot.on('error', (e) => console.error('Bot error:', e.message));
console.log('🤖 MTN MoMo Telegram Bot started');
