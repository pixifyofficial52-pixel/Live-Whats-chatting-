const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// ========== CORS configuration ==========
const allowedOrigins = [
    "https://live-whats-chatting-production.up.railway.app",
    "http://localhost:3000"
];

app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"]
}));

// ========== Force HTTPS redirect ==========
app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads'));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// File upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

const server = http.createServer(app);

// ========== Socket.io configuration ==========
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// ========== Data Stores ==========
const users = new Map();
const userNames = new Map();
const userDevices = new Map();
const offlineMessages = new Map();
const blockedUsers = new Set();
const callLogs = [];
const messageStore = [];
const adminUsers = new Set();

// ========== ADMIN API CONFIGURATION ==========
const ADMIN_API_KEY = 'hjchat-admin-secret-key-2024';

function verifyAdminKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
}

// ========== ADMIN API ENDPOINTS ==========
app.get('/api/admin/stats', verifyAdminKey, (req, res) => {
    const onlineCount = Array.from(users.values()).filter(u => u.socketId).length;
    const filesCount = fs.existsSync('uploads') ? fs.readdirSync('uploads').length : 0;
    
    res.json({
        totalUsers: users.size,
        onlineUsers: onlineCount,
        totalMessages: messageStore.length,
        callsToday: callLogs.filter(c => new Date(c.timestamp).toDateString() === new Date().toDateString()).length,
        totalFiles: filesCount,
        blockedUsers: blockedUsers.size,
        adminUsers: adminUsers.size
    });
});

app.get('/api/admin/users', verifyAdminKey, (req, res) => {
    const userList = [];
    users.forEach((value, key) => {
        userList.push({
            userId: key,
            name: value.name,
            online: true,
            deviceId: value.deviceId || 'N/A',
            profilePic: value.profilePic || null,
            lastSeen: new Date().toISOString(),
            joined: new Date().toISOString(),
            isAdmin: adminUsers.has(key)
        });
    });
    res.json(userList);
});

app.post('/api/admin/make-admin/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    if (users.has(userId)) {
        adminUsers.add(userId);
        io.emit('user-admin-status', { userId, isAdmin: true });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.post('/api/admin/remove-admin/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    adminUsers.delete(userId);
    io.emit('user-admin-status', { userId, isAdmin: false });
    res.json({ success: true });
});

app.post('/api/admin/block/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    if (blockedUsers.has(userId)) {
        blockedUsers.delete(userId);
    } else {
        blockedUsers.add(userId);
        if (users.has(userId)) {
            const user = users.get(userId);
            if (user.socketId) {
                io.to(user.socketId).emit('force-disconnect', { reason: 'blocked' });
            }
        }
    }
    res.json({ success: true });
});

app.delete('/api/admin/user/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    if (users.has(userId)) {
        const user = users.get(userId);
        if (user.socketId) {
            io.to(user.socketId).emit('force-disconnect', { reason: 'deleted' });
        }
        users.delete(userId);
        userNames.delete(user.name);
        adminUsers.delete(userId);
        if (user.deviceId) {
            userDevices.delete(user.deviceId);
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.get('/api/admin/calls', verifyAdminKey, (req, res) => {
    res.json(callLogs);
});

app.get('/api/admin/files', verifyAdminKey, (req, res) => {
    if (!fs.existsSync('uploads')) {
        return res.json([]);
    }
    const files = fs.readdirSync('uploads').map(file => {
        const stats = fs.statSync(path.join('uploads', file));
        return {
            name: file,
            size: stats.size,
            uploaded: stats.birthtime,
            url: `/uploads/${file}`
        };
    });
    res.json(files);
});

app.delete('/api/admin/file/:name', verifyAdminKey, (req, res) => {
    const { name } = req.params;
    const filePath = path.join('uploads', name);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ========== ADMIN PANEL ROUTE ==========
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ========== Regular Routes ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    const fileUrl = `/uploads/${file.filename}`;
    res.json({ 
        success: true, 
        fileUrl: fileUrl,
        fileName: file.originalname,
        fileType: file.mimetype
    });
});

// ========== Socket.io Handlers ==========
io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    socket.on('get-all-users', () => {
        const allUsers = [];
        users.forEach((value, key) => {
            allUsers.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                isAdmin: adminUsers.has(key)
            });
        });
        socket.emit('all-users', allUsers);
    });

    socket.on('search-users', (data) => {
        const { query, currentUserId } = data;
        const results = [];
        users.forEach((value, key) => {
            if (key === currentUserId) return;
            if (value.name.toLowerCase().includes(query.toLowerCase()) || key.toLowerCase().includes(query.toLowerCase())) {
                results.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic,
                    isAdmin: adminUsers.has(key)
                });
            }
        });
        socket.emit('search-results', results);
    });

    socket.on('check-username', (data) => {
        const { name, userId, deviceId } = data;
        const userDeviceId = deviceId || userId.split('_')[1] || userId;
        
        if (userNames.has(name)) {
            const existingUserId = userNames.get(name);
            const existingDeviceId = existingUserId.split('_')[1] || existingUserId;
            socket.emit('username-check-result', existingDeviceId !== userDeviceId);
        } else {
            socket.emit('username-check-result', false);
        }
    });

    socket.on('user-login', (data) => {
        const { userId, name, profilePic } = data;
        
        if (blockedUsers.has(userId)) {
            socket.emit('login-error', 'Your account has been blocked by admin');
            return;
        }
        
        const deviceId = userId.split('_')[1] || userId;
        
        if (userDevices.has(deviceId)) {
            const oldUserId = userDevices.get(deviceId);
            if (oldUserId !== userId) {
                socket.emit('login-error', 'This device already has a different user.');
                return;
            }
        }
        
        if (users.has(userId)) {
            const oldSocketId = users.get(userId).socketId;
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('force-disconnect');
                users.delete(userId);
            }
        }
        
        const isAdmin = adminUsers.has(userId);
        
        users.set(userId, {
            socketId: socket.id,
            name: name,
            profilePic: profilePic || null,
            deviceId: deviceId,
            isAdmin: isAdmin
        });
        
        userNames.set(name, userId);
        userDevices.set(deviceId, userId);
        socket.join(userId);
        
        const onlineUsers = [];
        users.forEach((value, key) => {
            if (key !== userId) {
                onlineUsers.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic,
                    isAdmin: adminUsers.has(key)
                });
            }
        });
        
        socket.emit('online-users', onlineUsers);
        socket.broadcast.emit('user-online', { userId, name, profilePic, isAdmin });
        
        if (offlineMessages.has(userId)) {
            const messages = offlineMessages.get(userId);
            messages.forEach(msg => {
                socket.emit('private-message', {
                    fromUserId: msg.fromUserId,
                    fromName: msg.fromName,
                    message: msg.message,
                    timestamp: msg.timestamp,
                    isOfflineDelivery: true
                });
            });
            offlineMessages.delete(userId);
        }
        
        console.log(`✅ User ${name} (${userId}) logged in ${isAdmin ? '👑' : ''}`);
    });

    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp } = data;
        
        if (blockedUsers.has(toUserId)) {
            socket.emit('message-blocked', { messageId });
            return;
        }
        
        messageStore.push({ messageId, fromUserId, fromName, toUserId, message, timestamp, type: 'text' });
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('private-message', { fromUserId, fromName, message, timestamp, messageId });
        } else {
            if (!offlineMessages.has(toUserId)) offlineMessages.set(toUserId, []);
            offlineMessages.get(toUserId).push({ fromUserId, fromName, message, timestamp, messageId });
            socket.emit('message-queued', { toUserId, message });
        }
    });

    socket.on('disconnect', () => {
        let disconnectedUser = null;
        let disconnectedUserId = null;
        
        users.forEach((value, key) => {
            if (value.socketId === socket.id) {
                disconnectedUser = value;
                disconnectedUserId = key;
            }
        });
        
        if (disconnectedUser) {
            users.delete(disconnectedUserId);
            userNames.delete(disconnectedUser.name);
            socket.broadcast.emit('user-offline', { userId: disconnectedUserId, name: disconnectedUser.name });
            console.log(`User ${disconnectedUser.name} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ HJH Chat running on https://live-whats-chatting-production.up.railway.app`);
    console.log(`✅ Admin panel: /admin`);
    console.log(`✅ Admin API key: hjchat-admin-secret-key-2024`);
});
