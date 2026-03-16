const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');

const app = express();

// ========== Global Error Handlers ==========
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Log error but don't crash
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
    // Log error but don't crash
});

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

// ========== Session for admin login ==========
app.use(session({
    secret: 'hj-hacker-super-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// ========== Force HTTPS redirect ==========
app.use((req, res, next) => {
    try {
        if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
            return res.redirect('https://' + req.headers.host + req.url);
        }
        next();
    } catch (err) {
        next();
    }
});

app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads'));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== Create folders if not exists ==========
try {
    if (!fs.existsSync('uploads')) {
        fs.mkdirSync('uploads');
    }
    if (!fs.existsSync('admin')) {
        fs.mkdirSync('admin');
    }
} catch (err) {
    console.error('Folder creation error:', err);
}

// ========== Users database file ==========
const USERS_DB_FILE = path.join(__dirname, 'admin', 'users.json');

// Create users.json file if not exists
try {
    if (!fs.existsSync(USERS_DB_FILE)) {
        fs.writeFileSync(USERS_DB_FILE, JSON.stringify({ users: [] }, null, 2));
    }
} catch (err) {
    console.error('Users file creation error:', err);
}

// ========== Helper functions with error handling ==========
function readUsersFromFile() {
    try {
        if (!fs.existsSync(USERS_DB_FILE)) {
            return { users: [] };
        }
        const data = fs.readFileSync(USERS_DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading users file:', error);
        return { users: [] };
    }
}

function writeUsersToFile(usersData) {
    try {
        // Create backup before writing
        if (fs.existsSync(USERS_DB_FILE)) {
            const backup = USERS_DB_FILE + '.backup';
            fs.copyFileSync(USERS_DB_FILE, backup);
        }
        
        fs.writeFileSync(USERS_DB_FILE, JSON.stringify(usersData, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing users file:', error);
        return false;
    }
}

// ========== Admin Login API ==========
const ADMIN_ACCESS_KEY = "HJ-HACKER76768085&SBL-HACKER76768085";

app.post('/admin/login', (req, res) => {
    try {
        const { accessKey } = req.body;
        
        if (accessKey === ADMIN_ACCESS_KEY) {
            req.session.isAdmin = true;
            res.json({ success: true, message: 'Login successful' });
        } else {
            res.status(401).json({ success: false, message: 'Invalid access key' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/admin/check-auth', (req, res) => {
    try {
        res.json({ isAuthenticated: req.session.isAdmin || false });
    } catch (err) {
        res.json({ isAuthenticated: false });
    }
});

app.post('/admin/logout', (req, res) => {
    try {
        req.session.destroy();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: true });
    }
});

// Admin middleware
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.status(401).sendFile(path.join(__dirname, 'admin', 'index.html'));
    }
}

// ========== Admin API endpoints ==========
app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/users', requireAdmin, (req, res) => {
    try {
        const usersData = readUsersFromFile();
        res.json(usersData);
    } catch (err) {
        res.json({ users: [] });
    }
});

// ========== File upload setup ==========
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

// ========== Socket.io configuration with error handling ==========
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// ========== Data Stores ==========
const users = new Map();
const userNames = new Map();
const userDevices = new Map();
const offlineMessages = new Map();

// Cleanup interval for offline messages (remove old messages)
setInterval(() => {
    try {
        const now = Date.now();
        for (const [userId, messages] of offlineMessages.entries()) {
            // Remove messages older than 7 days
            const filtered = messages.filter(msg => {
                return now - new Date(msg.timestamp).getTime() < 7 * 24 * 60 * 60 * 1000;
            });
            if (filtered.length === 0) {
                offlineMessages.delete(userId);
            } else {
                offlineMessages.set(userId, filtered);
            }
        }
    } catch (err) {
        console.error('Cleanup error:', err);
    }
}, 60 * 60 * 1000); // Every hour

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.json({ success: false, error: 'No file uploaded' });
        }
        const fileUrl = `/uploads/${file.filename}`;
        res.json({ 
            success: true, 
            fileUrl: fileUrl,
            fileName: file.originalname,
            fileType: file.mimetype
        });
    } catch (err) {
        res.json({ success: false, error: 'Upload failed' });
    }
});

io.on('connection', (socket) => {
    console.log('🟢 New user connected:', socket.id);

    // Send online users list to admin panel
    try {
        const onlineUsersList = [];
        users.forEach((value, key) => {
            onlineUsersList.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic
            });
        });
        socket.emit('online-users-list', onlineUsersList);
    } catch (err) {
        console.error('Error sending online users:', err);
    }

    // ========== User login ==========
    socket.on('user-login', (data) => {
        try {
            const { userId, name, profilePic } = data;
            
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
            
            // Save user to permanent storage
            const usersData = readUsersFromFile();
            const existingUserIndex = usersData.users.findIndex(u => u.userId === userId);
            
            const userRecord = {
                userId,
                name,
                profilePic: profilePic || null,
                deviceId,
                lastSeen: new Date().toISOString()
            };
            
            if (existingUserIndex === -1) {
                userRecord.firstSeen = new Date().toISOString();
                usersData.users.push(userRecord);
                console.log(`✅ New user saved: ${name}`);
            } else {
                usersData.users[existingUserIndex] = {
                    ...usersData.users[existingUserIndex],
                    ...userRecord,
                    firstSeen: usersData.users[existingUserIndex].firstSeen || new Date().toISOString()
                };
                console.log(`✅ User updated: ${name}`);
            }
            
            writeUsersToFile(usersData);
            
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
            socket.broadcast.emit('user-online', { userId, name, profilePic: profilePic || null });
            
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
            }
            
        } catch (err) {
            console.error('Login error:', err);
        }
    });

    // ========== Private message ==========
    socket.on('private-message', (data) => {
        try {
            const { toUserId, message, fromUserId, fromName, messageId, timestamp } = data;
            
            if (users.has(toUserId)) {
                io.to(toUserId).emit('private-message', {
                    fromUserId,
                    fromName,
                    message,
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
                    message,
                    timestamp,
                    messageId
                });
                socket.emit('message-queued', { toUserId, message });
            }
        } catch (err) {
            console.error('Message error:', err);
        }
    });

    // ========== Voice message ==========
    socket.on('voice-message', (data) => {
        try {
            const { toUserId, audioUrl, fromUserId, fromName, duration, messageId, timestamp } = data;
            
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
        } catch (err) {
            console.error('Voice message error:', err);
        }
    });

    // ========== File message ==========
    socket.on('file-message', (data) => {
        try {
            const { toUserId, fileUrl, fileName, fileType, fromUserId, fromName, messageId, timestamp } = data;
            
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
        } catch (err) {
            console.error('File message error:', err);
        }
    });

    // ========== Delete message ==========
    socket.on('delete-message', (data) => {
        try {
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
            } else if (deleteType === 'for-me') {
                io.to(fromUserId).emit('message-deleted', {
                    messageId,
                    deleteType,
                    fromUserId,
                    timestamp
                });
            }
        } catch (err) {
            console.error('Delete message error:', err);
        }
    });

    // ========== Typing indicator ==========
    socket.on('typing', (data) => {
        try {
            const { toUserId, fromUserId, isTyping } = data;
            if (users.has(toUserId)) {
                io.to(toUserId).emit('typing-indicator', { fromUserId, isTyping });
            }
        } catch (err) {
            console.error('Typing error:', err);
        }
    });

    // ========== Call signaling ==========
    socket.on('call-offer', (data) => {
        try {
            const { toUserId, offer, callType } = data;
            const fromUser = users.get(socket.id);
            
            if (users.has(toUserId)) {
                io.to(toUserId).emit('call-offer', {
                    fromUserId: socket.id,
                    fromName: fromUser?.name,
                    offer,
                    callType
                });
            }
        } catch (err) {
            console.error('Call offer error:', err);
        }
    });

    socket.on('call-answer', (data) => {
        try {
            const { toUserId, answer } = data;
            io.to(toUserId).emit('call-answer', { answer });
        } catch (err) {
            console.error('Call answer error:', err);
        }
    });

    socket.on('ice-candidate', (data) => {
        try {
            const { toUserId, candidate } = data;
            io.to(toUserId).emit('ice-candidate', { candidate });
        } catch (err) {
            console.error('ICE candidate error:', err);
        }
    });

    socket.on('call-end', (data) => {
        try {
            const { toUserId } = data;
            io.to(toUserId).emit('call-end');
        } catch (err) {
            console.error('Call end error:', err);
        }
    });

    socket.on('call-busy', (data) => {
        try {
            const { toUserId } = data;
            io.to(toUserId).emit('call-busy');
        } catch (err) {
            console.error('Call busy error:', err);
        }
    });

    // ========== Last seen update ==========
    socket.on('update-last-seen', (data) => {
        try {
            const { userId, timestamp } = data;
            
            const usersData = readUsersFromFile();
            const userIndex = usersData.users.findIndex(u => u.userId === userId);
            if (userIndex !== -1) {
                usersData.users[userIndex].lastSeen = new Date(timestamp).toISOString();
                writeUsersToFile(usersData);
            }
            
            socket.broadcast.emit('last-seen-update', { userId, timestamp });
        } catch (err) {
            console.error('Last seen error:', err);
        }
    });

    // ========== Status events ==========
    socket.on('new-status', (data) => {
        try {
            socket.broadcast.emit('new-status', data);
        } catch (err) {
            console.error('New status error:', err);
        }
    });

    socket.on('status-viewed', (data) => {
        try {
            io.to(data.ownerId).emit('status-viewed', {
                statusId: data.statusId,
                viewerId: data.viewerId,
                viewerName: data.viewerName
            });
        } catch (err) {
            console.error('Status viewed error:', err);
        }
    });

    // ========== Handle disconnection ==========
    socket.on('disconnect', () => {
        try {
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
                
                const usersData = readUsersFromFile();
                const userIndex = usersData.users.findIndex(u => u.userId === disconnectedUserId);
                if (userIndex !== -1) {
                    usersData.users[userIndex].lastSeen = new Date().toISOString();
                    writeUsersToFile(usersData);
                }
                
                socket.broadcast.emit('user-offline', {
                    userId: disconnectedUserId,
                    name: disconnectedUser.name
                });
                
                console.log(`🔴 User ${disconnectedUser.name} disconnected`);
            }
        } catch (err) {
            console.error('Disconnect error:', err);
        }
    });

    // Error handler for socket
    socket.on('error', (err) => {
        console.error('Socket error:', err);
    });
});

// ========== Health check endpoint ==========
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        users: users.size,
        offlineMessages: offlineMessages.size
    });
});

// ========== Error handling middleware ==========
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ========== Start server ==========
const PORT = process.env.PORT || 3000;

// Handle server errors
server.on('error', (err) => {
    console.error('Server error:', err);
});

server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`✅ Server started successfully!`);
    console.log(`📱 Chat app: https://live-whats-chatting-production.up.railway.app`);
    console.log(`👑 Admin panel: https://live-whats-chatting-production.up.railway.app/admin`);
    console.log(`🔐 Access key is HIDDEN for security`);
    console.log(`💪 Stable version with error handling`);
    console.log('='.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
