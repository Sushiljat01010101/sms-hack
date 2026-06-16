const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory database
// codes: code -> { deviceId, deviceName, paired: boolean, adminDeviceId: String }
const codes = {}; 
// notifications: deviceId -> Array of Notification Objects
const notifications = {}; 
// adminPairs: adminDeviceId -> userDeviceId
const adminPairs = {};
// deviceNames: deviceId -> name
const deviceNames = {};

// Helper to generate a unique random uppercase alphanumeric code (6 characters)
function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude ambiguous characters like I, O, 0, 1
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (codes[code]); // Ensure uniqueness
  return code;
}

// Generate a random ID
function generateId() {
  return 'dev_' + Math.random().toString(36).substring(2, 15);
}

// Welcome Dashboard Page
app.get('/', (req, res) => {
  const activeUsers = Object.keys(deviceNames).length;
  const activePairs = Object.keys(adminPairs).length;
  let totalNotificationsCount = 0;
  Object.values(notifications).forEach(list => {
    totalNotificationsCount += list.length;
  });

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>NotifyBridge Server</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono&display=swap');
        body {
          font-family: 'Space Grotesk', sans-serif;
        }
        .code-font {
          font-family: 'JetBrains Mono', monospace;
        }
      </style>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col justify-between">
      
      <!-- Navbar -->
      <nav class="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md px-6 py-4 flex justify-between items-center">
        <div class="flex items-center space-x-3">
          <span class="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-teal-500 bg-clip-text text-transparent">NotifyBridge</span>
          <span class="px-2.5 py-0.5 text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 rounded-full font-medium">Server Live</span>
        </div>
        <div class="text-sm text-slate-400 code-font">v1.0.0</div>
      </nav>

      <!-- Main Content -->
      <main class="max-w-4xl mx-auto px-6 py-12 flex-grow w-full">
        <div class="text-center mb-12">
          <h1 class="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            Forward Notifications Seamlessly
          </h1>
          <p class="text-slate-400 text-lg max-w-xl mx-auto">
            Your high-performance notification forwarding engine is up and running. Ready to connect your Android user and admin app instances.
          </p>
        </div>

        <!-- Metrics Grid -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div class="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col">
            <span class="text-slate-400 text-sm font-medium mb-1">Registered User Devices</span>
            <span class="text-4xl font-bold text-slate-100">${activeUsers}</span>
          </div>
          <div class="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col">
            <span class="text-slate-400 text-sm font-medium mb-1">Active Paired Connections</span>
            <span class="text-4xl font-bold text-teal-400">${activePairs}</span>
          </div>
          <div class="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex flex-col">
            <span class="text-slate-400 text-sm font-medium mb-1">Notifications Forwarded</span>
            <span class="text-4xl font-bold text-emerald-400">${totalNotificationsCount}</span>
          </div>
        </div>

        <!-- Connection Guide -->
        <div class="bg-slate-900/30 border border-slate-800/80 rounded-2xl p-8">
          <h2 class="text-xl font-bold mb-4 flex items-center space-x-2">
            <svg class="w-5 h-5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
            <span>How to Connect Your App</span>
          </h2>
          <div class="space-y-4 text-slate-300">
            <div class="flex items-start space-x-3">
              <span class="bg-slate-800 text-slate-300 w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">1</span>
              <div>
                <p class="font-medium text-slate-200">Set the Server Link</p>
                <p class="text-sm text-slate-400">In the Android App, make sure the Server URL is set to this website URL (excluding trailing slashes).</p>
              </div>
            </div>
            <div class="flex items-start space-x-3">
              <span class="bg-slate-800 text-slate-300 w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">2</span>
              <div>
                <p class="font-medium text-slate-200">Generate Pairing Code</p>
                <p class="text-sm text-slate-400">Open the app on the User's phone to generate a unique 6-character connection code.</p>
              </div>
            </div>
            <div class="flex items-start space-x-3">
              <span class="bg-slate-800 text-slate-300 w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">3</span>
              <div>
                <p class="font-medium text-slate-200">Connect Admin Instance</p>
                <p class="text-sm text-slate-400">Enter that code into the Admin section of the second phone to establish a secure notification socket bridge.</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- Footer -->
      <footer class="border-t border-slate-900/80 bg-slate-950 px-6 py-6 text-center text-sm text-slate-500">
        <div>Deployed on Render / Cloud Platform &bull; Secured with HTTPS</div>
      </footer>

    </body>
    </html>
  `);
});

// 1. REGISTER USER DEVICE
// Request: { deviceName: '...' }
// Response: { deviceId: '...', code: '...' }
app.post('/api/register', (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName) {
    return res.status(400).json({ error: 'deviceName is required' });
  }

  const deviceId = generateId();
  const code = generatePairingCode();

  codes[code] = {
    deviceId,
    deviceName,
    paired: false,
    adminDeviceId: null
  };

  notifications[deviceId] = [];
  deviceNames[deviceId] = deviceName;

  console.log(`Registered User Device: ${deviceName} [${deviceId}] with Code: ${code}`);

  res.json({
    deviceId,
    code
  });
});

// 2. PAIR ADMIN DEVICE WITH USER VIA CODE
// Request: { adminDeviceId: '...', code: '...' }
// Response: { success: true, pairedDeviceId: '...', pairedDeviceName: '...' }
app.post('/api/pair', (req, res) => {
  const { adminDeviceId, code } = req.body;
  if (!adminDeviceId || !code) {
    return res.status(400).json({ error: 'adminDeviceId and code are required' });
  }

  const normalizedCode = code.trim().toUpperCase();
  const registration = codes[normalizedCode];

  if (!registration) {
    return res.status(404).json({ error: 'Invalid pairing code' });
  }

  // Update pairing maps
  registration.paired = true;
  registration.adminDeviceId = adminDeviceId;
  adminPairs[adminDeviceId] = registration.deviceId;

  console.log(`Admin paired successfully: ${adminDeviceId} connected to User: ${registration.deviceName} [${registration.deviceId}]`);

  res.json({
    success: true,
    pairedDeviceId: registration.deviceId,
    pairedDeviceName: registration.deviceName
  });
});

// 3. CHECK PAIRING STATUS
// Request: GET /api/status?deviceId=... OR GET /api/status?adminDeviceId=...
// Response: { paired: boolean, pairedDeviceName: '...', ... }
app.get('/api/status', (req, res) => {
  const { deviceId, adminDeviceId } = req.query;

  if (deviceId) {
    // Check if user is paired to an admin
    const codeEntry = Object.values(codes).find(c => c.deviceId === deviceId);
    if (codeEntry && codeEntry.paired) {
      return res.json({
        paired: true,
        adminDeviceId: codeEntry.adminDeviceId
      });
    }
    return res.json({ paired: false });
  }

  if (adminDeviceId) {
    const pairedUserId = adminPairs[adminDeviceId];
    if (pairedUserId) {
      return res.json({
        paired: true,
        pairedDeviceId: pairedUserId,
        pairedDeviceName: deviceNames[pairedUserId] || 'User'
      });
    }
    return res.json({ paired: false });
  }

  res.status(400).json({ error: 'Must check either deviceId or adminDeviceId' });
});

// 4. POST NOTIFICATION FROM USER DEVICE
// Request: { deviceId: '...', packageName: '...', title: '...', text: '...', timestamp: 123456789 }
app.post('/api/notifications', (req, res) => {
  const { deviceId, packageName, title, text, timestamp } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  const list = notifications[deviceId];
  if (!list) {
    return res.status(404).json({ error: 'Device not registered' });
  }

  const notificationItem = {
    packageName: packageName || 'unknown',
    title: title || 'No Title',
    text: text || '',
    timestamp: timestamp || Date.now()
  };

  list.unshift(notificationItem); // Prepend to show newest first

  // Trim list to last 100 notifications to keep memory low
  if (list.length > 100) {
    list.pop();
  }

  console.log(`Received notification for ${deviceId}: [${packageName}] ${title} - ${text}`);

  res.json({ success: true });
});

// 5. GET NOTIFICATIONS FOR ADMIN
// Request: GET /api/notifications?adminDeviceId=...
app.get('/api/notifications', (req, res) => {
  const { adminDeviceId } = req.query;
  if (!adminDeviceId) {
    return res.status(400).json({ error: 'adminDeviceId is required' });
  }

  const userDeviceId = adminPairs[adminDeviceId];
  if (!userDeviceId) {
    return res.json([]); // Return empty list rather than 404, or return empty indicating not paired
  }

  const list = notifications[userDeviceId] || [];
  res.json(list);
});

// Start listening
app.listen(PORT, '0.0.0.5' /* bind to all interfaces */ && '0.0.0.0', () => {
  console.log(`NotifyBridge Server running on Port ${PORT}`);
});
