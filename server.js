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
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Create admin folder if not exists
if (!fs.existsSync('admin')) {
    fs.mkdirSync('admin');
}

// Create users.json file to store permanent user records
const USERS_DB_FILE = path.join(__dirname, 'admin', 'users.json');
if (!fs.existsSync(USERS_DB_FILE)) {
    fs.writeFileSync(USERS_DB_FILE, JSON.stringify({ users: [] }, null, 2));
}

// Helper function to read users from file
function readUsersFromFile() {
    try {
        const data = fs.readFileSync(USERS_DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading users file:', error);
        return { users: [] };
    }
}

// Helper function to write users to file
function writeUsersToFile(usersData) {
    try {
        fs.writeFileSync(USERS_DB_FILE, JSON.stringify(usersData, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing users file:', error);
        return false;
    }
}

// ========== Admin API endpoints ==========
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/users', (req, res) => {
    const usersData = readUsersFromFile();
    res.json(usersData);
});

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

io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    // Send online users list to admin panel
    const onlineUsersList = [];
    users.forEach((value, key) => {
        onlineUsersList.push({
            userId: key,
            name: value.name,
            profilePic: value.profilePic
        });
    });
    socket.emit('online-users-list', onlineUsersList);

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
        
        // ========== Save user to permanent storage ==========
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
            // New user
            userRecord.firstSeen = new Date().toISOString();
            usersData.users.push(userRecord);
            console.log(`✅ New user permanently saved: ${name} (${userId})`);
        } else {
            // Update existing user
            usersData.users[existingUserIndex] = {
                ...usersData.users[existingUserIndex],
                ...userRecord,
                firstSeen: usersData.users[existingUserIndex].firstSeen || new Date().toISOString()
            };
            console.log(`✅ Existing user updated: ${name} (${userId})`);
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
            
            // Update in permanent storage
            const usersData = readUsersFromFile();
            const userIndex = usersData.users.findIndex(u => u.userId === userId);
            if (userIndex !== -1) {
                usersData.users[userIndex].profilePic = profilePic;
                writeUsersToFile(usersData);
            }
            
            socket.broadcast.emit('profile-updated', {
                userId,
                profilePic
            });
        }
    });

    // ========== Private message with offline support ==========
    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp } = data;
        
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

    // ========== Message read receipt ==========
    socket.on('message-read', (data) => {
        const { messageId, fromUserId, toUserId } = data;
        io.to(fromUserId).emit('message-read', {
            messageId,
            fromUserId: toUserId
        });
    });

    // ========== All messages read ==========
    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
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
        io.to(toUserId).emit('call-answer', { answer });
    });

    socket.on('ice-candidate', (data) => {
        const { toUserId, candidate } = data;
        io.to(toUserId).emit('ice-candidate', { candidate });
    });

    socket.on('call-end', (data) => {
        const { toUserId } = data;
        io.to(toUserId).emit('call-end');
    });

    socket.on('call-busy', (data) => {
        const { toUserId } = data;
        io.to(toUserId).emit('call-busy');
    });

    // ========== Last seen update ==========
    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        
        const usersData = readUsersFromFile();
        const userIndex = usersData.users.findIndex(u => u.userId === userId);
        if (userIndex !== -1) {
            usersData.users[userIndex].lastSeen = new Date(timestamp).toISOString();
            writeUsersToFile(usersData);
        }
        
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
            
            console.log(`User ${disconnectedUser.name} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ HJH Chat app running on https://live-whats-chatting-production.up.railway.app`);
    console.log(`✅ Admin panel available at: https://live-whats-chatting-production.up.railway.app/admin`);
});
