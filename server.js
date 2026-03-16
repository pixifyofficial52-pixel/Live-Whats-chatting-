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
    methods: ["GET", "POST"],
    credentials: true
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
app.use(express.json());

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// ========== Data Stores ==========
const users = new Map(); // Online users only
const registeredUsers = new Map(); // All registered users (persistent)
const userNames = new Map();
const userDevices = new Map();
const offlineMessages = new Map();
const specialUsers = new Set();
const messageHistory = [];
const fileRecords = []; // Store file metadata

// File paths for persistence
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const FILES_FILE = path.join(DATA_DIR, 'files.json');

// Create data directory if not exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Load persistent data
function loadPersistentData() {
    try {
        // Load registered users
        if (fs.existsSync(USERS_FILE)) {
            const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            Object.keys(usersData).forEach(key => {
                registeredUsers.set(key, usersData[key]);
            });
            console.log(`✅ Loaded ${registeredUsers.size} registered users`);
        }
        
        // Load message history
        if (fs.existsSync(MESSAGES_FILE)) {
            const messagesData = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
            messageHistory.push(...messagesData);
            console.log(`✅ Loaded ${messageHistory.length} messages`);
        }
        
        // Load file records
        if (fs.existsSync(FILES_FILE)) {
            const filesData = JSON.parse(fs.readFileSync(FILES_FILE, 'utf8'));
            fileRecords.push(...filesData);
            console.log(`✅ Loaded ${fileRecords.length} file records`);
        }
    } catch (error) {
        console.error('Error loading persistent data:', error);
    }
}

// Save registered users
function saveUsers() {
    try {
        const usersObj = {};
        registeredUsers.forEach((value, key) => {
            usersObj[key] = value;
        });
        fs.writeFileSync(USERS_FILE, JSON.stringify(usersObj, null, 2));
    } catch (error) {
        console.error('Error saving users:', error);
    }
}

// Save messages
function saveMessages() {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageHistory.slice(-1000), null, 2)); // Keep last 1000 messages
    } catch (error) {
        console.error('Error saving messages:', error);
    }
}

// Save file records
function saveFiles() {
    try {
        fs.writeFileSync(FILES_FILE, JSON.stringify(fileRecords, null, 2));
    } catch (error) {
        console.error('Error saving files:', error);
    }
}

// Load data on startup
loadPersistentData();

// Admin key
const ADMIN_KEY = "HJ-HACKER76768085&SBL-HACKER76768085";

// ========== Admin authentication middleware ==========
const authenticateAdmin = (req, res, next) => {
    const adminKey = req.headers['admin-key'] || req.query.key;
    
    if (adminKey === ADMIN_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized access' });
    }
};

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

// ========== ADMIN PANEL ROUTE ==========
app.get('/harisjutttt', (req, res) => {
    res.sendFile(path.join(__dirname, 'harisjutttt.html'));
});

app.get('/admin', (req, res) => {
    res.status(404).send('Not Found');
});

// ========== ADMIN API ENDPOINTS ==========

// Get all users for admin (including offline)
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const userList = [];
    
    // Include all registered users
    registeredUsers.forEach((value, key) => {
        userList.push({
            userId: key,
            name: value.name,
            profilePic: value.profilePic,
            deviceId: value.deviceId,
            online: users.has(key), // Check if currently online
            registeredAt: value.registeredAt,
            lastSeen: value.lastSeen,
            isSpecial: value.isSpecial || false,
            specialBadge: value.specialBadge || null,
            totalMessages: value.totalMessages || 0,
            totalFiles: value.totalFiles || 0
        });
    });
    
    res.json(userList);
});

// Get dashboard stats
app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
    let fileCount = 0;
    let filesList = [];
    try {
        const files = fs.readdirSync('uploads');
        fileCount = files.length;
        filesList = files.map(f => ({
            name: f,
            path: `/uploads/${f}`,
            size: fs.statSync(path.join('uploads', f)).size,
            uploadedAt: fs.statSync(path.join('uploads', f)).birthtime
        }));
    } catch (e) {
        fileCount = 0;
    }

    // Get recent messages
    const recentMessages = messageHistory.slice(-50).map(msg => ({
        ...msg,
        fromUser: registeredUsers.get(msg.fromUserId)?.name || 'Unknown',
        toUser: registeredUsers.get(msg.toUserId)?.name || 'Unknown'
    }));

    res.json({
        totalUsers: registeredUsers.size, // All registered users
        onlineUsers: users.size, // Currently online
        specialUsers: specialUsers.size,
        totalMessages: messageHistory.length,
        totalFiles: fileCount,
        fileRecords: fileRecords.slice(-20), // Last 20 files
        recentMessages: recentMessages,
        offlineMessages: offlineMessages.size,
        registeredUsers: Array.from(registeredUsers.values()).map(u => ({
            ...u,
            online: users.has(u.userId)
        }))
    });
});

// Get message history
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
    const { limit = 100, userId } = req.query;
    
    let messages = messageHistory;
    
    if (userId) {
        messages = messages.filter(m => m.fromUserId === userId || m.toUserId === userId);
    }
    
    // Add user names
    messages = messages.slice(-parseInt(limit)).map(msg => ({
        ...msg,
        fromName: registeredUsers.get(msg.fromUserId)?.name || 'Unknown',
        toName: registeredUsers.get(msg.toUserId)?.name || 'Unknown'
    }));
    
    res.json(messages.reverse());
});

// Get files list
app.get('/api/admin/files', authenticateAdmin, (req, res) => {
    const files = [];
    try {
        const uploadDir = 'uploads';
        const fileNames = fs.readdirSync(uploadDir);
        
        fileNames.forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            files.push({
                name: file,
                url: `/uploads/${file}`,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime
            });
        });
    } catch (e) {
        console.error('Error reading uploads:', e);
    }
    
    res.json(files);
});

// Get all special users
app.get('/api/admin/special-users', authenticateAdmin, (req, res) => {
    const specials = [];
    registeredUsers.forEach((value, key) => {
        if (value.isSpecial) {
            specials.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                badgeType: value.specialBadge,
                online: users.has(key),
                deviceId: value.deviceId,
                registeredAt: value.registeredAt
            });
        }
    });
    res.json(specials);
});

// Make user special (ADD CROWN)
app.post('/api/admin/make-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    if (registeredUsers.has(userId)) {
        const user = registeredUsers.get(userId);
        user.isSpecial = true;
        user.specialBadge = badgeType || 'crown';
        registeredUsers.set(userId, user);
        saveUsers();
        
        specialUsers.add(userId);
        
        // Update online user if exists
        if (users.has(userId)) {
            const onlineUser = users.get(userId);
            onlineUser.isSpecial = true;
            onlineUser.specialBadge = user.specialBadge;
            users.set(userId, onlineUser);
        }
        
        // Force emit to all clients
        io.emit('user-special-updated', {
            userId: userId,
            isSpecial: true,
            badgeType: user.specialBadge,
            name: user.name,
            action: 'added'
        });
        
        io.to(userId).emit('special-status-changed', {
            isSpecial: true,
            badgeType: user.specialBadge
        });
        
        res.json({ 
            success: true, 
            message: `👑 Crown awarded to ${user.name}!`,
            user: {
                userId: userId,
                name: user.name,
                badgeType: user.specialBadge
            }
        });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Remove special status (REMOVE CROWN)
app.post('/api/admin/remove-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId } = req.body;
    
    if (registeredUsers.has(userId)) {
        const user = registeredUsers.get(userId);
        
        if (!user.isSpecial) {
            return res.status(400).json({ error: 'User is not a special user' });
        }
        
        const oldBadge = user.specialBadge;
        user.isSpecial = false;
        user.specialBadge = null;
        registeredUsers.set(userId, user);
        saveUsers();
        
        specialUsers.delete(userId);
        
        // Update online user if exists
        if (users.has(userId)) {
            const onlineUser = users.get(userId);
            onlineUser.isSpecial = false;
            onlineUser.specialBadge = null;
            users.set(userId, onlineUser);
        }
        
        io.emit('user-special-updated', {
            userId: userId,
            isSpecial: false,
            name: user.name,
            action: 'removed',
            oldBadge: oldBadge
        });
        
        io.to(userId).emit('special-status-changed', {
            isSpecial: false,
            badgeType: null
        });
        
        res.json({ 
            success: true, 
            message: `👑 Crown removed from ${user.name}`,
            user: {
                userId: userId,
                name: user.name
            }
        });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Update badge type
app.post('/api/admin/update-badge', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    if (registeredUsers.has(userId)) {
        const user = registeredUsers.get(userId);
        
        if (!user.isSpecial) {
            return res.status(400).json({ error: 'User is not a special user' });
        }
        
        const oldBadge = user.specialBadge;
        user.specialBadge = badgeType;
        registeredUsers.set(userId, user);
        saveUsers();
        
        // Update online user if exists
        if (users.has(userId)) {
            const onlineUser = users.get(userId);
            onlineUser.specialBadge = badgeType;
            users.set(userId, onlineUser);
        }
        
        io.emit('user-special-updated', {
            userId: userId,
            isSpecial: true,
            badgeType: badgeType,
            name: user.name,
            action: 'updated',
            oldBadge: oldBadge
        });
        
        io.to(userId).emit('special-status-changed', {
            isSpecial: true,
            badgeType: badgeType
        });
        
        res.json({ 
            success: true, 
            message: `Badge updated for ${user.name}`,
            user: {
                userId: userId,
                name: user.name,
                badgeType: badgeType
            }
        });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Clear old data (optional, for admin)
app.post('/api/admin/clear-old-data', authenticateAdmin, (req, res) => {
    const { days = 30 } = req.body;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    // Clear old messages
    const originalLength = messageHistory.length;
    // Filter out messages older than cutoffDate
    const newMessageHistory = messageHistory.filter(msg => new Date(msg.timestamp) > cutoffDate);
    messageHistory.length = 0;
    messageHistory.push(...newMessageHistory);
    saveMessages();
    
    res.json({
        success: true,
        message: `Cleared data older than ${days} days`,
        messagesRemoved: originalLength - messageHistory.length
    });
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    const fileUrl = `/uploads/${file.filename}`;
    
    // Record file metadata
    const fileRecord = {
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: fileUrl,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.body.userId || 'unknown'
    };
    
    fileRecords.push(fileRecord);
    saveFiles();
    
    res.json({ 
        success: true, 
        fileUrl: fileUrl,
        fileName: file.originalname,
        fileType: file.mimetype
    });
});

// ========== SOCKET.IO EVENTS ==========
io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    socket.on('get-all-users', (callback) => {
        const allUsers = [];
        users.forEach((value, key) => {
            allUsers.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                isSpecial: value.isSpecial || false,
                specialBadge: value.specialBadge || null,
                online: true
            });
        });
        
        if (typeof callback === 'function') {
            callback(allUsers);
        } else {
            socket.emit('all-users', allUsers);
        }
    });

    socket.on('search-users', (data) => {
        const { query, currentUserId } = data;
        
        const results = [];
        users.forEach((value, key) => {
            if (key === currentUserId) return;
            
            const nameMatch = value.name.toLowerCase().includes(query.toLowerCase());
            const idMatch = key.toLowerCase().includes(query.toLowerCase());
            
            if (nameMatch || idMatch) {
                results.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic,
                    isSpecial: value.isSpecial || false,
                    specialBadge: value.specialBadge || null
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
            
            if (existingDeviceId === userDeviceId) {
                socket.emit('username-check-result', false);
            } else {
                socket.emit('username-check-result', true);
            }
        } else {
            socket.emit('username-check-result', false);
        }
    });

    socket.on('user-login', (data) => {
        const { userId, name, profilePic } = data;
        
        const deviceId = userId.split('_')[1] || userId;
        
        if (userDevices.has(deviceId)) {
            const oldUserId = userDevices.get(deviceId);
            if (oldUserId !== userId) {
                socket.emit('login-error', 'This device already has a different user. Please use another device.');
                return;
            }
        }
        
        const isSpecial = specialUsers.has(userId);
        
        // Check if user exists in registered users
        if (!registeredUsers.has(userId)) {
            // New user - register them permanently
            registeredUsers.set(userId, {
                userId: userId,
                name: name,
                profilePic: profilePic || null,
                deviceId: deviceId,
                registeredAt: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                isSpecial: isSpecial,
                specialBadge: isSpecial ? 'crown' : null,
                totalMessages: 0,
                totalFiles: 0
            });
            saveUsers();
        } else {
            // Update existing user
            const user = registeredUsers.get(userId);
            user.lastSeen = new Date().toISOString();
            user.name = name; // Update name if changed
            user.profilePic = profilePic || user.profilePic;
            registeredUsers.set(userId, user);
            saveUsers();
        }
        
        if (users.has(userId)) {
            const oldSocketId = users.get(userId).socketId;
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('force-disconnect');
                users.delete(userId);
            }
        }
        
        users.set(userId, {
            socketId: socket.id,
            name: name,
            profilePic: profilePic || null,
            deviceId: deviceId,
            isSpecial: isSpecial,
            specialBadge: isSpecial ? 'crown' : null
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
                    isSpecial: value.isSpecial || false,
                    specialBadge: value.specialBadge || null
                });
            }
        });
        
        socket.emit('online-users', onlineUsers);
        
        socket.broadcast.emit('user-online', { 
            userId, 
            name, 
            profilePic: profilePic || null,
            isSpecial: isSpecial,
            specialBadge: isSpecial ? 'crown' : null
        });
        
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
            console.log(`Delivered ${messages.length} offline messages to ${name}`);
        }
        
        console.log(`✅ User ${name} (${userId}) logged in from device ${deviceId} ${isSpecial ? '👑' : ''}`);
    });

    socket.on('update-profile', (data) => {
        const { userId, profilePic } = data;
        
        if (users.has(userId)) {
            const user = users.get(userId);
            user.profilePic = profilePic;
            users.set(userId, user);
            
            // Update in registered users
            if (registeredUsers.has(userId)) {
                const regUser = registeredUsers.get(userId);
                regUser.profilePic = profilePic;
                registeredUsers.set(userId, regUser);
                saveUsers();
            }
            
            socket.broadcast.emit('profile-updated', {
                userId,
                profilePic
            });
        }
    });

    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp, fromUserSpecial } = data;
        
        messageHistory.push({
            fromUserId,
            toUserId,
            message,
            timestamp,
            type: 'text',
            messageId
        });
        
        // Update user message count
        if (registeredUsers.has(fromUserId)) {
            const user = registeredUsers.get(fromUserId);
            user.totalMessages = (user.totalMessages || 0) + 1;
            registeredUsers.set(fromUserId, user);
            saveUsers();
        }
        
        // Save messages periodically (every 10 messages)
        if (messageHistory.length % 10 === 0) {
            saveMessages();
        }
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('private-message', {
                fromUserId,
                fromName,
                message,
                timestamp,
                messageId,
                fromUserSpecial
            });
            
            console.log(`Message sent from ${fromName} to ${toUserId}`);
        } else {
            if (!offlineMessages.has(toUserId)) {
                offlineMessages.set(toUserId, []);
            }
            
            offlineMessages.get(toUserId).push({
                fromUserId,
                fromName,
                message,
                timestamp,
                messageId,
                type: 'text',
                fromUserSpecial
            });
            
            console.log(`Message queued for offline user ${toUserId}`);
            
            socket.emit('message-queued', {
                toUserId,
                message
            });
        }
    });

    socket.on('voice-message', (data) => {
        const { toUserId, audioUrl, fromUserId, fromName, duration, messageId, timestamp, fromUserSpecial } = data;
        
        messageHistory.push({
            fromUserId,
            toUserId,
            audioUrl,
            duration,
            timestamp,
            type: 'voice',
            messageId
        });
        
        // Update user message count
        if (registeredUsers.has(fromUserId)) {
            const user = registeredUsers.get(fromUserId);
            user.totalMessages = (user.totalMessages || 0) + 1;
            registeredUsers.set(fromUserId, user);
            saveUsers();
        }
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('voice-message', {
                fromUserId,
                fromName,
                audioUrl,
                duration,
                timestamp,
                messageId,
                fromUserSpecial
            });
        } else {
            if (!offlineMessages.has(toUserId)) {
                offlineMessages.set(toUserId, []);
            }
            
            offlineMessages.get(toUserId).push({
                fromUserId,
                fromName,
                type: 'voice',
                audioUrl,
                duration,
                timestamp,
                messageId,
                fromUserSpecial
            });
        }
    });

    socket.on('file-message', (data) => {
        const { toUserId, fileUrl, fileName, fileType, fromUserId, fromName, messageId, timestamp, fromUserSpecial } = data;
        
        messageHistory.push({
            fromUserId,
            toUserId,
            fileUrl,
            fileName,
            fileType,
            timestamp,
            type: 'file',
            messageId
        });
        
        // Update user file count
        if (registeredUsers.has(fromUserId)) {
            const user = registeredUsers.get(fromUserId);
            user.totalFiles = (user.totalFiles || 0) + 1;
            registeredUsers.set(fromUserId, user);
            saveUsers();
        }
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('file-message', {
                fromUserId,
                fromName,
                fileUrl,
                fileName,
                fileType,
                timestamp,
                messageId,
                fromUserSpecial
            });
        } else {
            if (!offlineMessages.has(toUserId)) {
                offlineMessages.set(toUserId, []);
            }
            
            offlineMessages.get(toUserId).push({
                fromUserId,
                fromName,
                type: 'file',
                fileUrl,
                fileName,
                fileType,
                timestamp,
                messageId,
                fromUserSpecial
            });
        }
    });

    socket.on('delete-message', (data) => {
        const { messageId, toUserId, deleteType, fromUserId, timestamp } = data;
        
        if (deleteType === 'for-everyone') {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('message-deleted', {
                    messageId,
                    deleteType,
                    fromUserId,
                    timestamp
                });
            }
            
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for everyone`);
        } else if (deleteType === 'for-me') {
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for user ${fromUserId}`);
        }
    });

    socket.on('message-read', (data) => {
        const { messageId, fromUserId, toUserId } = data;
        io.to(fromUserId).emit('message-read', {
            messageId,
            fromUserId: toUserId
        });
    });

    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('messages-read', {
            fromUserId
        });
    });

    socket.on('typing', (data) => {
        const { toUserId, fromUserId, isTyping } = data;
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('typing-indicator', {
                fromUserId,
                isTyping
            });
        }
    });

    socket.on('call-offer', (data) => {
        const { toUserId, offer, callType, fromUserId, fromName } = data;
        const fromUser = users.get(fromUserId);
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-offer', {
                fromUserId,
                fromName,
                offer,
                callType,
                fromUserSpecial: fromUser?.isSpecial || false
            });
        }
    });

    socket.on('call-answer', (data) => {
        const { toUserId, answer, fromUserId } = data;
        io.to(toUserId).emit('call-answer', { answer, fromUserId });
    });

    socket.on('ice-candidate', (data) => {
        const { toUserId, candidate, fromUserId } = data;
        io.to(toUserId).emit('ice-candidate', { candidate, fromUserId });
    });

    socket.on('call-end', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('call-end', { fromUserId });
    });

    socket.on('call-busy', (data) => {
        const { toUserId } = data;
        io.to(toUserId).emit('call-busy');
    });

    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        
        // Update last seen in registered users
        if (registeredUsers.has(userId)) {
            const user = registeredUsers.get(userId);
            user.lastSeen = timestamp;
            registeredUsers.set(userId, user);
            saveUsers();
        }
        
        socket.broadcast.emit('last-seen-update', {
            userId,
            timestamp
        });
    });

    socket.on('new-status', (data) => {
        socket.broadcast.emit('new-status', data);
    });

    socket.on('status-viewed', (data) => {
        io.to(data.ownerId).emit('status-viewed', {
            statusId: data.statusId,
            viewerId: data.viewerId,
            viewerName: data.viewerName
        });
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
            // Update last seen in registered users
            if (registeredUsers.has(disconnectedUserId)) {
                const user = registeredUsers.get(disconnectedUserId);
                user.lastSeen = new Date().toISOString();
                registeredUsers.set(disconnectedUserId, user);
                saveUsers();
            }
            
            users.delete(disconnectedUserId);
            userNames.delete(disconnectedUser.name);
            
            socket.broadcast.emit('user-offline', {
                userId: disconnectedUserId,
                name: disconnectedUser.name,
                wasSpecial: disconnectedUser.isSpecial || false
            });
            
            console.log(`User ${disconnectedUser.name} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ HJH Chat app running on https://live-whats-chatting-production.up.railway.app`);
    console.log(`✅ Admin panel: https://live-whats-chatting-production.up.railway.app/harisjutttt`);
    console.log(`❌ /admin is disabled - returns 404`);
    console.log(`✅ Admin Key: ${ADMIN_KEY}`);
});
