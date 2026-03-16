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

// Get all users for admin
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

// Get dashboard stats
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

// Get all special users
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

// Make user special (ADD CROWN) - UPDATED WITH PERSISTENCE
app.post('/api/admin/make-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    if (users.has(userId)) {
        const user = users.get(userId);
        user.isSpecial = true;
        user.specialBadge = badgeType || 'crown';
        users.set(userId, user);
        
        specialUsers.add(userId);
        
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

// Update badge type
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

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
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
