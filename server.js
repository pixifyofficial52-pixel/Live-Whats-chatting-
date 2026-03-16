const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// ========== IMPROVED CORS configuration ==========
const allowedOrigins = [
    "https://live-whats-chatting-production.up.railway.app",
    "http://localhost:3000"
];

// More permissive CORS for development, restrictive for production
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1 && process.env.NODE_ENV === 'production') {
            return callback(new Error('CORS policy violation'), false);
        }
        return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "admin-key", "my-custom-header"]
}));

// Handle preflight requests
app.options('*', cors());

// ========== Force HTTPS redirect ==========
app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

// Important: Serve static files first
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads', { recursive: true });
}

// ========== Data Stores ==========
const users = new Map();
const userNames = new Map();
const userDevices = new Map();
const offlineMessages = new Map();
const specialUsers = new Set();
const messageHistory = [];

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
        cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

const server = http.createServer(app);

// ========== IMPROVED Socket.io configuration ==========
const io = socketIo(server, {
    cors: {
        origin: function(origin, callback) {
            // Allow all origins in production temporarily to debug
            if (process.env.NODE_ENV === 'production') {
                return callback(null, true);
            }
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header", "Content-Type", "Authorization"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// ========== ADMIN PANEL ROUTE ==========
app.get('/harisjutttt', (req, res) => {
    res.sendFile(path.join(__dirname, 'harisjutttt.html'));
});

// Block /admin route
app.get('/admin', (req, res) => {
    res.status(404).send('Not Found');
});

// ========== Root route to serve index.html ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint (important for Railway)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== ADMIN API ENDPOINTS ==========
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const userList = [];
    users.forEach((value, key) => {
        userList.push({
            userId: key,
            name: value.name,
            profilePic: value.profilePic,
            deviceId: value.deviceId,
            online: true,
            socketId: value.socketId,
            isSpecial: value.isSpecial || false,
            specialBadge: value.specialBadge || null
        });
    });
    res.json(userList);
});

app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
    let fileCount = 0;
    try {
        fileCount = fs.readdirSync('uploads').length;
    } catch (e) {
        fileCount = 0;
    }

    res.json({
        totalUsers: users.size,
        onlineUsers: users.size,
        specialUsers: specialUsers.size,
        totalMessages: messageHistory.length,
        totalFiles: fileCount,
        offlineMessages: offlineMessages.size
    });
});

app.get('/api/admin/special-users', authenticateAdmin, (req, res) => {
    const specials = [];
    users.forEach((value, key) => {
        if (value.isSpecial) {
            specials.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                badgeType: value.specialBadge,
                online: true,
                deviceId: value.deviceId
            });
        }
    });
    res.json(specials);
});

app.post('/api/admin/make-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    if (users.has(userId)) {
        const user = users.get(userId);
        user.isSpecial = true;
        user.specialBadge = badgeType || 'crown';
        users.set(userId, user);
        
        specialUsers.add(userId);
        
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

app.post('/api/admin/remove-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId } = req.body;
    
    if (users.has(userId)) {
        const user = users.get(userId);
        
        if (!user.isSpecial) {
            return res.status(400).json({ error: 'User is not a special user' });
        }
        
        const oldBadge = user.specialBadge;
        user.isSpecial = false;
        user.specialBadge = null;
        users.set(userId, user);
        
        specialUsers.delete(userId);
        
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

app.post('/api/admin/update-badge', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    if (users.has(userId)) {
        const user = users.get(userId);
        
        if (!user.isSpecial) {
            return res.status(400).json({ error: 'User is not a special user' });
        }
        
        const oldBadge = user.specialBadge;
        user.specialBadge = badgeType;
        users.set(userId, user);
        
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

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const fileUrl = `/uploads/${file.filename}`;
        res.json({ 
            success: true, 
            fileUrl: fileUrl,
            fileName: file.originalname,
            fileType: file.mimetype,
            size: file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ========== SOCKET.IO EVENTS ==========
io.on('connection', (socket) => {
    console.log('🟢 New client connected:', socket.id, 'IP:', socket.handshake.address);

    // Send acknowledgment
    socket.emit('connected', { id: socket.id, message: 'Connected to server' });

    // Get all users
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

    // Check username
    socket.on('check-username', (data) => {
        const { name, userId, deviceId } = data;
        const userDeviceId = deviceId || userId.split('_')[1] || userId;
        
        if (userNames.has(name)) {
            const existingUserId = userNames.get(name);
            const existingDeviceId = existingUserId.split('_')[1] || existingUserId;
            
            socket.emit('username-check-result', existingDeviceId === userDeviceId);
        } else {
            socket.emit('username-check-result', false);
        }
    });

    // User login
    socket.on('user-login', (data) => {
        const { userId, name, profilePic } = data;
        const deviceId = userId.split('_')[1] || userId;
        
        // Check device
        if (userDevices.has(deviceId)) {
            const oldUserId = userDevices.get(deviceId);
            if (oldUserId !== userId) {
                socket.emit('login-error', 'This device already has a different user');
                return;
            }
        }
        
        // Disconnect old session
        if (users.has(userId)) {
            const oldSocketId = users.get(userId).socketId;
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('force-disconnect');
                users.delete(userId);
            }
        }
        
        // Check special status
        const isSpecial = specialUsers.has(userId);
        
        // Store user
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
        
        // Send online users
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
        
        // Broadcast online status
        socket.broadcast.emit('user-online', { 
            userId, 
            name, 
            profilePic: profilePic || null,
            isSpecial: isSpecial,
            specialBadge: isSpecial ? 'crown' : null
        });
        
        // Deliver offline messages
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
            console.log(`📨 Delivered ${messages.length} offline messages to ${name}`);
        }
        
        console.log(`✅ User ${name} (${userId}) logged in ${isSpecial ? '👑' : ''}`);
    });

    // Search users
    socket.on('search-users', (data) => {
        const { query, currentUserId } = data;
        const results = [];
        
        users.forEach((value, key) => {
            if (key === currentUserId) return;
            
            if (value.name.toLowerCase().includes(query.toLowerCase()) || 
                key.toLowerCase().includes(query.toLowerCase())) {
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

    // Profile update
    socket.on('update-profile', (data) => {
        const { userId, profilePic } = data;
        
        if (users.has(userId)) {
            const user = users.get(userId);
            user.profilePic = profilePic;
            users.set(userId, user);
            
            socket.broadcast.emit('profile-updated', { userId, profilePic });
        }
    });

    // Private message
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
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('private-message', {
                fromUserId,
                fromName,
                message,
                timestamp,
                messageId,
                fromUserSpecial
            });
            console.log(`💬 Message from ${fromName} to ${toUserId}`);
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
            socket.emit('message-queued', { toUserId, message });
        }
    });

    // Voice message
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

    // File message
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

    // Delete message
    socket.on('delete-message', (data) => {
        const { messageId, toUserId, deleteType, fromUserId, timestamp } = data;
        
        if (deleteType === 'for-everyone') {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('message-deleted', { messageId, deleteType, fromUserId, timestamp });
            }
            io.to(fromUserId).emit('message-deleted', { messageId, deleteType, fromUserId, timestamp });
        } else if (deleteType === 'for-me') {
            io.to(fromUserId).emit('message-deleted', { messageId, deleteType, fromUserId, timestamp });
        }
    });

    // Message read
    socket.on('message-read', (data) => {
        const { messageId, fromUserId, toUserId } = data;
        io.to(fromUserId).emit('message-read', { messageId, fromUserId: toUserId });
    });

    // Messages read
    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('messages-read', { fromUserId });
    });

    // Typing
    socket.on('typing', (data) => {
        const { toUserId, fromUserId, isTyping } = data;
        if (users.has(toUserId)) {
            io.to(toUserId).emit('typing-indicator', { fromUserId, isTyping });
        }
    });

    // Call signaling
    socket.on('call-offer', (data) => {
        const { toUserId, offer, callType, fromUserId, fromName } = data;
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-offer', {
                fromUserId,
                fromName,
                offer,
                callType,
                fromUserSpecial: users.get(fromUserId)?.isSpecial || false
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

    // Last seen
    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        socket.broadcast.emit('last-seen-update', { userId, timestamp });
    });

    // Disconnect
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
            
            socket.broadcast.emit('user-offline', {
                userId: disconnectedUserId,
                name: disconnectedUser.name,
                wasSpecial: disconnectedUser.isSpecial || false
            });
            
            console.log(`🔴 User ${disconnectedUser.name} disconnected`);
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Main app: https://live-whats-chatting-production.up.railway.app`);
    console.log(`👑 Admin panel: https://live-whats-chatting-production.up.railway.app/harisjutttt`);
    console.log(`🔑 Admin key: ${ADMIN_KEY}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
});
