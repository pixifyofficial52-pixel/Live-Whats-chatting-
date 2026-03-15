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
const users = new Map(); // userId -> {socketId, name, profilePic, deviceId}
const userNames = new Map(); // name -> userId (for uniqueness)
const userDevices = new Map(); // deviceId -> userId (for device tracking)
const offlineMessages = new Map(); // userId -> [messages] (store offline messages)
const blockedUsers = new Set(); // Store blocked user IDs
const callLogs = []; // Store call history for admin
const messageStore = []; // Store messages for admin (optional)

// ========== ADMIN API CONFIGURATION ==========
const ADMIN_API_KEY = 'hjchat-admin-secret-key-2024';

// Admin API middleware
function verifyAdminKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
}

// ========== ADMIN API ENDPOINTS ==========

// Get dashboard stats
app.get('/api/admin/stats', verifyAdminKey, (req, res) => {
    const onlineCount = Array.from(users.values()).filter(u => u.socketId).length;
    const filesCount = fs.existsSync('uploads') ? fs.readdirSync('uploads').length : 0;
    
    // Count today's calls
    const today = new Date().toDateString();
    const callsToday = callLogs.filter(call => 
        new Date(call.timestamp).toDateString() === today
    ).length;
    
    res.json({
        totalUsers: users.size,
        onlineUsers: onlineCount,
        totalMessages: messageStore.length,
        callsToday: callsToday,
        totalFiles: filesCount,
        blockedUsers: blockedUsers.size
    });
});

// Get all users
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
            joined: new Date().toISOString() // You might want to store actual join date
        });
    });
    res.json(userList);
});

// Block/Unblock user
app.post('/api/admin/block/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    
    if (blockedUsers.has(userId)) {
        blockedUsers.delete(userId);
        res.json({ success: true, message: 'User unblocked', blocked: false });
    } else {
        blockedUsers.add(userId);
        // Disconnect user if online
        if (users.has(userId)) {
            const user = users.get(userId);
            if (user.socketId) {
                io.to(user.socketId).emit('force-disconnect', { reason: 'blocked' });
            }
        }
        res.json({ success: true, message: 'User blocked', blocked: true });
    }
});

// Delete user
app.delete('/api/admin/user/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    
    if (users.has(userId)) {
        const user = users.get(userId);
        
        // Disconnect user if online
        if (user.socketId) {
            io.to(user.socketId).emit('force-disconnect', { reason: 'deleted' });
        }
        
        // Remove from all maps
        users.delete(userId);
        userNames.delete(user.name);
        
        // Remove from device tracking
        if (user.deviceId) {
            userDevices.delete(user.deviceId);
        }
        
        console.log(`Admin deleted user: ${userId} (${user.name})`);
        res.json({ success: true, message: 'User deleted successfully' });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Get messages for specific user
app.get('/api/admin/messages/:userId', verifyAdminKey, (req, res) => {
    const { userId } = req.params;
    
    // Filter messages for this user (both sent and received)
    const userMessages = messageStore.filter(msg => 
        msg.fromUserId === userId || msg.toUserId === userId
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.json(userMessages);
});

// Delete specific message
app.post('/api/admin/message', verifyAdminKey, (req, res) => {
    const { messageId } = req.body;
    
    // Broadcast delete to all users
    io.emit('admin-delete-message', { messageId });
    
    // Remove from message store if exists
    const index = messageStore.findIndex(m => m.messageId === messageId);
    if (index !== -1) {
        messageStore.splice(index, 1);
    }
    
    res.json({ success: true, message: 'Message deleted' });
});

// Get call logs
app.get('/api/admin/calls', verifyAdminKey, (req, res) => {
    res.json(callLogs);
});

// Get all files
app.get('/api/admin/files', verifyAdminKey, (req, res) => {
    if (!fs.existsSync('uploads')) {
        return res.json([]);
    }
    
    const files = fs.readdirSync('uploads').map(file => {
        const filePath = path.join('uploads', file);
        const stats = fs.statSync(filePath);
        return {
            name: file,
            size: stats.size,
            uploaded: stats.birthtime,
            url: `/uploads/${file}`
        };
    });
    res.json(files);
});

// Delete file
app.delete('/api/admin/file/:name', verifyAdminKey, (req, res) => {
    const { name } = req.params;
    const filePath = path.join('uploads', name);
    
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true, message: 'File deleted' });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Get blocked words list
app.get('/api/admin/blocked-words', verifyAdminKey, (req, res) => {
    // You can store blocked words in a file or database
    const blockedWords = [];
    res.json(blockedWords);
});

// Add blocked word
app.post('/api/admin/blocked-words', verifyAdminKey, (req, res) => {
    const { word } = req.body;
    // Add to your blocked words storage
    res.json({ success: true, message: 'Word added' });
});

// Delete blocked word
app.delete('/api/admin/blocked-words/:word', verifyAdminKey, (req, res) => {
    const { word } = req.params;
    // Remove from your blocked words storage
    res.json({ success: true, message: 'Word removed' });
});

// Get settings
app.get('/api/admin/settings', verifyAdminKey, (req, res) => {
    // You can store settings in a file or database
    const settings = {
        siteName: 'HJH Chat',
        maintenanceMode: false,
        enableVoice: true,
        enableVideo: true,
        maxMessageLength: 5000,
        maxFileSize: 50,
        allowedFileTypes: ['jpg', 'png', 'pdf', 'mp3', 'mp4']
    };
    res.json(settings);
});

// Update settings
app.post('/api/admin/settings', verifyAdminKey, (req, res) => {
    const settings = req.body;
    // Save settings to file or database
    fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
    console.log('Settings updated:', settings);
    res.json({ success: true, message: 'Settings saved' });
});

// ========== Regular Routes ==========
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

// ========== Socket.io Handlers ==========
io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    // ========== Get all users for search ==========
    socket.on('get-all-users', () => {
        const allUsers = [];
        users.forEach((value, key) => {
            allUsers.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic
            });
        });
        socket.emit('all-users', allUsers);
    });

    // ========== Search users ==========
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
                    profilePic: value.profilePic
                });
            }
        });
        
        socket.emit('search-results', results);
    });

    // ========== Check username uniqueness ==========
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

    // ========== User login ==========
    socket.on('user-login', (data) => {
        const { userId, name, profilePic } = data;
        
        // Check if user is blocked
        if (blockedUsers.has(userId)) {
            socket.emit('login-error', 'Your account has been blocked by admin');
            return;
        }
        
        const deviceId = userId.split('_')[1] || userId;
        
        if (userDevices.has(deviceId)) {
            const oldUserId = userDevices.get(deviceId);
            if (oldUserId !== userId) {
                socket.emit('login-error', 'This device already has a different user. Please use another device.');
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
        
        users.set(userId, {
            socketId: socket.id,
            name: name,
            profilePic: profilePic || null,
            deviceId: deviceId
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
                    profilePic: value.profilePic
                });
            }
        });
        
        socket.emit('online-users', onlineUsers);
        
        socket.broadcast.emit('user-online', { 
            userId, 
            name, 
            profilePic: profilePic || null 
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
        
        console.log(`✅ User ${name} (${userId}) logged in from device ${deviceId}`);
    });

    // ========== Profile picture update ==========
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

    // ========== Private message with offline support ==========
    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp } = data;
        
        // Check if recipient is blocked
        if (blockedUsers.has(toUserId)) {
            socket.emit('message-blocked', { messageId, reason: 'recipient blocked' });
            return;
        }
        
        // Store message for admin
        messageStore.push({
            messageId,
            fromUserId,
            fromName,
            toUserId,
            message,
            timestamp,
            type: 'text'
        });
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('private-message', {
                fromUserId,
                fromName,
                message,
                timestamp,
                messageId
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
                messageId
            });
            
            console.log(`Message queued for offline user ${toUserId}`);
            
            socket.emit('message-queued', {
                toUserId,
                message
            });
        }
    });

    // ========== Voice message with offline support ==========
    socket.on('voice-message', (data) => {
        const { toUserId, audioUrl, fromUserId, fromName, duration, messageId, timestamp } = data;
        
        // Store for admin
        messageStore.push({
            messageId,
            fromUserId,
            fromName,
            toUserId,
            audioUrl,
            duration,
            timestamp,
            type: 'voice'
        });
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('voice-message', {
                fromUserId,
                fromName,
                audioUrl,
                duration,
                timestamp,
                messageId
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
                messageId
            });
        }
    });

    // ========== File message with offline support ==========
    socket.on('file-message', (data) => {
        const { toUserId, fileUrl, fileName, fileType, fromUserId, fromName, messageId, timestamp } = data;
        
        // Store for admin
        messageStore.push({
            messageId,
            fromUserId,
            fromName,
            toUserId,
            fileUrl,
            fileName,
            fileType,
            timestamp,
            type: 'file'
        });
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('file-message', {
                fromUserId,
                fromName,
                fileUrl,
                fileName,
                fileType,
                timestamp,
                messageId
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
                messageId
            });
        }
    });

    // ========== Delete message handler ==========
    socket.on('delete-message', (data) => {
        const { messageId, toUserId, deleteType, fromUserId, timestamp } = data;
        
        // Remove from message store
        const msgIndex = messageStore.findIndex(m => m.messageId === messageId);
        if (msgIndex !== -1) {
            messageStore[msgIndex].deleted = true;
            messageStore[msgIndex].deletedAt = timestamp;
            messageStore[msgIndex].deletedBy = fromUserId;
        }
        
        // Broadcast to both users if delete for everyone
        if (deleteType === 'for-everyone') {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('message-deleted', {
                    messageId,
                    deleteType,
                    fromUserId,
                    timestamp
                });
            }
            
            // Also send back to sender for other devices
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for everyone`);
        } 
        // For delete for me, just send to sender's other devices
        else if (deleteType === 'for-me') {
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for user ${fromUserId}`);
        }
    });

    // ========== Message read receipt ==========
    socket.on('message-read', (data) => {
        const { messageId, fromUserId, toUserId } = data;
        
        // Update in message store
        const msg = messageStore.find(m => m.messageId === messageId);
        if (msg) {
            msg.read = true;
            msg.readAt = new Date().toISOString();
        }
        
        io.to(fromUserId).emit('message-read', {
            messageId,
            fromUserId: toUserId
        });
    });

    // ========== All messages read ==========
    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
        
        // Mark all messages from this user as read
        messageStore.forEach(msg => {
            if (msg.fromUserId === fromUserId && msg.toUserId === toUserId) {
                msg.read = true;
                msg.readAt = new Date().toISOString();
            }
        });
        
        io.to(toUserId).emit('messages-read', {
            fromUserId
        });
    });

    // ========== Typing indicator ==========
    socket.on('typing', (data) => {
        const { toUserId, fromUserId, isTyping } = data;
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('typing-indicator', {
                fromUserId,
                isTyping
            });
        }
    });

    // ========== Call signaling ==========
    socket.on('call-offer', (data) => {
        const { toUserId, offer, callType } = data;
        const fromUser = users.get(socket.id);
        
        // Log call for admin
        callLogs.push({
            caller: fromUser?.name || 'Unknown',
            callerId: socket.id,
            receiver: toUserId,
            type: callType,
            status: 'initiated',
            timestamp: new Date().toISOString()
        });
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-offer', {
                fromUserId: socket.id,
                fromName: fromUser?.name,
                offer,
                callType
            });
        }
    });

    socket.on('call-answer', (data) => {
        const { toUserId, answer } = data;
        
        // Update call log
        const lastCall = callLogs[callLogs.length - 1];
        if (lastCall) {
            lastCall.status = 'answered';
            lastCall.answeredAt = new Date().toISOString();
        }
        
        io.to(toUserId).emit('call-answer', { answer });
    });

    socket.on('ice-candidate', (data) => {
        const { toUserId, candidate } = data;
        io.to(toUserId).emit('ice-candidate', { candidate });
    });

    socket.on('call-end', (data) => {
        const { toUserId } = data;
        
        // Update call log with duration
        const lastCall = callLogs[callLogs.length - 1];
        if (lastCall && lastCall.status === 'answered') {
            const endTime = new Date();
            const startTime = new Date(lastCall.answeredAt);
            lastCall.duration = Math.floor((endTime - startTime) / 1000);
            lastCall.status = 'completed';
        } else if (lastCall) {
            lastCall.status = 'missed';
        }
        
        io.to(toUserId).emit('call-end');
    });

    socket.on('call-busy', (data) => {
        const { toUserId } = data;
        
        // Update call log
        const lastCall = callLogs[callLogs.length - 1];
        if (lastCall) {
            lastCall.status = 'busy';
        }
        
        io.to(toUserId).emit('call-busy');
    });

    // ========== Last seen update ==========
    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        socket.broadcast.emit('last-seen-update', {
            userId,
            timestamp
        });
    });

    // ========== Status events ==========
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

    // ========== Handle disconnection ==========
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
                name: disconnectedUser.name
            });
            
            console.log(`User ${disconnectedUser.name} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ HJH Chat app running on https://live-whats-chatting-production.up.railway.app`);
    console.log(`✅ Admin API enabled with key: hjchat-admin-secret-key-2024`);
});
