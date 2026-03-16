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

// ========== PERSISTENT STORAGE FILES ==========
const USERS_DATA_FILE = path.join(__dirname, 'users-data.json');
const MESSAGES_DATA_FILE = path.join(__dirname, 'messages-data.json');
const FILES_DATA_FILE = path.join(__dirname, 'files-data.json');
const SPECIAL_USERS_FILE = path.join(__dirname, 'special-users.json');

// ========== Data Stores ==========
let users = new Map();           // Active users with socket connections
let allUsers = new Map();        // All registered users (persistent)
let userNames = new Map();
let userDevices = new Map();
let offlineMessages = new Map();
let specialUsers = new Set();
let messageHistory = [];         // All messages (persistent)
let filesList = [];              // All uploaded files (persistent)

// Admin key
const ADMIN_KEY = "HJ-HACKER76768085&SBL-HACKER76768085";

// ========== LOAD ALL DATA FROM FILES ==========
function loadAllData() {
    try {
        // Load all users
        if (fs.existsSync(USERS_DATA_FILE)) {
            const data = fs.readFileSync(USERS_DATA_FILE, 'utf8');
            const savedUsers = JSON.parse(data);
            savedUsers.forEach(userData => {
                allUsers.set(userData.userId, {
                    name: userData.name,
                    profilePic: userData.profilePic,
                    deviceId: userData.deviceId,
                    isSpecial: userData.isSpecial || false,
                    specialBadge: userData.specialBadge || null,
                    firstSeen: userData.firstSeen || new Date().toISOString(),
                    lastSeen: userData.lastSeen || new Date().toISOString()
                });
                
                userNames.set(userData.name, userData.userId);
                userDevices.set(userData.deviceId, userData.userId);
            });
            console.log(`✅ Loaded ${allUsers.size} users from file`);
        }
        
        // Load special users
        if (fs.existsSync(SPECIAL_USERS_FILE)) {
            const data = fs.readFileSync(SPECIAL_USERS_FILE, 'utf8');
            const savedSpecials = JSON.parse(data);
            savedSpecials.forEach(userId => specialUsers.add(userId));
            console.log(`✅ Loaded ${specialUsers.size} special users from file`);
        }
        
        // Load message history
        if (fs.existsSync(MESSAGES_DATA_FILE)) {
            const data = fs.readFileSync(MESSAGES_DATA_FILE, 'utf8');
            messageHistory = JSON.parse(data);
            console.log(`✅ Loaded ${messageHistory.length} messages from file`);
        }
        
        // Load files list
        if (fs.existsSync(FILES_DATA_FILE)) {
            const data = fs.readFileSync(FILES_DATA_FILE, 'utf8');
            filesList = JSON.parse(data);
            console.log(`✅ Loaded ${filesList.length} files from file`);
        } else {
            // Scan uploads folder for files
            try {
                const uploadFiles = fs.readdirSync('uploads');
                uploadFiles.forEach(file => {
                    const filePath = `/uploads/${file}`;
                    const stats = fs.statSync(path.join('uploads', file));
                    filesList.push({
                        fileName: file,
                        fileUrl: filePath,
                        fileType: getFileType(file),
                        size: stats.size,
                        uploadedAt: stats.birthtime.toISOString()
                    });
                });
                saveFilesData();
                console.log(`✅ Scanned ${filesList.length} files from uploads folder`);
            } catch (e) {
                console.log('No uploads folder found');
            }
        }
        
    } catch (e) {
        console.error('Error loading data:', e);
    }
}

// Helper function to get file type
function getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) return 'image';
    if (['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.ogg', '.m4a', '.aac'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'document';
    return 'other';
}

// ========== SAVE DATA TO FILES ==========
function saveUsersData() {
    try {
        const usersArray = [];
        allUsers.forEach((value, key) => {
            usersArray.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                deviceId: value.deviceId,
                isSpecial: value.isSpecial || false,
                specialBadge: value.specialBadge || null,
                firstSeen: value.firstSeen,
                lastSeen: value.lastSeen
            });
        });
        fs.writeFileSync(USERS_DATA_FILE, JSON.stringify(usersArray, null, 2));
    } catch (e) {
        console.error('Error saving users data:', e);
    }
}

function saveMessagesData() {
    try {
        fs.writeFileSync(MESSAGES_DATA_FILE, JSON.stringify(messageHistory, null, 2));
    } catch (e) {
        console.error('Error saving messages data:', e);
    }
}

function saveFilesData() {
    try {
        fs.writeFileSync(FILES_DATA_FILE, JSON.stringify(filesList, null, 2));
    } catch (e) {
        console.error('Error saving files data:', e);
    }
}

function saveSpecialUsers() {
    try {
        fs.writeFileSync(SPECIAL_USERS_FILE, JSON.stringify(Array.from(specialUsers), null, 2));
    } catch (e) {
        console.error('Error saving special users:', e);
    }
}

// Load all data on startup
loadAllData();

// Admin authentication middleware
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

// Get all users for admin (ALL USERS - ONLINE + OFFLINE)
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const userList = [];
    
    // Add all users from persistent storage
    allUsers.forEach((value, key) => {
        userList.push({
            userId: key,
            name: value.name,
            profilePic: value.profilePic,
            deviceId: value.deviceId,
            online: users.has(key), // Check if currently online
            socketId: users.get(key)?.socketId || null,
            isSpecial: value.isSpecial || false,
            specialBadge: value.specialBadge || null,
            firstSeen: value.firstSeen,
            lastSeen: value.lastSeen
        });
    });
    
    res.json(userList);
});

// Get dashboard stats
app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
    // Count online users
    const onlineCount = users.size;
    
    // Count total files
    let fileCount = filesList.length;
    try {
        // Also count files in uploads folder
        const uploadFiles = fs.readdirSync('uploads');
        fileCount = Math.max(fileCount, uploadFiles.length);
    } catch (e) {}
    
    // Count images, videos, etc.
    const images = filesList.filter(f => f.fileType === 'image').length;
    const videos = filesList.filter(f => f.fileType === 'video').length;
    const audios = filesList.filter(f => f.fileType === 'audio').length;
    const documents = filesList.filter(f => f.fileType === 'document').length;

    res.json({
        totalUsers: allUsers.size,           // ALL users ever registered
        onlineUsers: onlineCount,             // Currently online users
        offlineUsers: allUsers.size - onlineCount, // Offline users
        specialUsers: specialUsers.size,
        totalMessages: messageHistory.length,
        textMessages: messageHistory.filter(m => m.type === 'text').length,
        voiceMessages: messageHistory.filter(m => m.type === 'voice').length,
        fileMessages: messageHistory.filter(m => m.type === 'file').length,
        totalFiles: fileCount,
        images: images,
        videos: videos,
        audios: audios,
        documents: documents,
        offlineMessages: offlineMessages.size
    });
});

// Get message history
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
    const { limit = 100, userId } = req.query;
    
    let messages = messageHistory;
    
    // Filter by user if specified
    if (userId) {
        messages = messages.filter(m => m.fromUserId === userId || m.toUserId === userId);
    }
    
    // Sort by timestamp (newest first)
    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Apply limit
    messages = messages.slice(0, parseInt(limit));
    
    res.json(messages);
});

// Get files list
app.get('/api/admin/files', authenticateAdmin, (req, res) => {
    res.json(filesList);
});

// Get all special users
app.get('/api/admin/special-users', authenticateAdmin, (req, res) => {
    const specials = [];
    allUsers.forEach((value, key) => {
        if (value.isSpecial) {
            specials.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                badgeType: value.specialBadge,
                online: users.has(key),
                deviceId: value.deviceId,
                lastSeen: value.lastSeen
            });
        }
    });
    res.json(specials);
});

// Make user special (ADD CROWN) - PERSISTENT
app.post('/api/admin/make-special', authenticateAdmin, express.json(), (req, res) => {
    const { userId, badgeType } = req.body;
    
    console.log(`👑 Admin making user special: ${userId}`);
    
    if (allUsers.has(userId)) {
        const user = allUsers.get(userId);
        user.isSpecial = true;
        user.specialBadge = badgeType || 'crown';
        allUsers.set(userId, user);
        
        // Also update in active users if online
        if (users.has(userId)) {
            const activeUser = users.get(userId);
            activeUser.isSpecial = true;
            activeUser.specialBadge = user.specialBadge;
            users.set(userId, activeUser);
        }
        
        specialUsers.add(userId);
        
        // SAVE TO FILE
        saveUsersData();
        saveSpecialUsers();
        
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
    
    if (allUsers.has(userId)) {
        const user = allUsers.get(userId);
        
        if (!user.isSpecial) {
            return res.status(400).json({ error: 'User is not a special user' });
        }
        
        const oldBadge = user.specialBadge;
        user.isSpecial = false;
        user.specialBadge = null;
        allUsers.set(userId, user);
        
        // Also update in active users if online
        if (users.has(userId)) {
            const activeUser = users.get(userId);
            activeUser.isSpecial = false;
            activeUser.specialBadge = null;
            users.set(userId, activeUser);
        }
        
        specialUsers.delete(userId);
        
        // SAVE TO FILE
        saveUsersData();
        saveSpecialUsers();
        
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

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    const fileUrl = `/uploads/${file.filename}`;
    
    // Add to files list
    const fileInfo = {
        fileName: file.originalname,
        fileUrl: fileUrl,
        fileType: getFileType(file.originalname),
        size: file.size,
        uploadedAt: new Date().toISOString(),
        savedAs: file.filename
    };
    filesList.push(fileInfo);
    saveFilesData();
    
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
        const allUsersList = [];
        allUsers.forEach((value, key) => {
            allUsersList.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic,
                isSpecial: value.isSpecial || false,
                specialBadge: value.specialBadge || null,
                online: users.has(key)
            });
        });
        
        if (typeof callback === 'function') {
            callback(allUsersList);
        } else {
            socket.emit('all-users', allUsersList);
        }
    });

    socket.on('search-users', (data) => {
        const { query, currentUserId } = data;
        
        const results = [];
        allUsers.forEach((value, key) => {
            if (key === currentUserId) return;
            
            const nameMatch = value.name.toLowerCase().includes(query.toLowerCase());
            const idMatch = key.toLowerCase().includes(query.toLowerCase());
            
            if (nameMatch || idMatch) {
                results.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic,
                    isSpecial: value.isSpecial || false,
                    specialBadge: value.specialBadge || null,
                    online: users.has(key)
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
        
        // Check if user exists in allUsers, if not add them
        if (!allUsers.has(userId)) {
            // New user
            allUsers.set(userId, {
                name: name,
                profilePic: profilePic || null,
                deviceId: deviceId,
                isSpecial: specialUsers.has(userId),
                specialBadge: specialUsers.has(userId) ? 'crown' : null,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            });
            
            userNames.set(name, userId);
            userDevices.set(deviceId, userId);
            
            saveUsersData();
            console.log(`📝 New user registered: ${name} (${userId})`);
        } else {
            // Update last seen
            const user = allUsers.get(userId);
            user.lastSeen = new Date().toISOString();
            allUsers.set(userId, user);
            saveUsersData();
        }
        
        const isSpecial = allUsers.get(userId).isSpecial || false;
        
        // Add to active users
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
        
        socket.join(userId);
        
        // Send online users list to new user
        const onlineUsersList = [];
        users.forEach((value, key) => {
            if (key !== userId) {
                onlineUsersList.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic,
                    isSpecial: value.isSpecial || false,
                    specialBadge: value.specialBadge || null
                });
            }
        });
        
        socket.emit('online-users', onlineUsersList);
        
        // Broadcast new user online to everyone
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
        }
        
        if (allUsers.has(userId)) {
            const user = allUsers.get(userId);
            user.profilePic = profilePic;
            allUsers.set(userId, user);
            saveUsersData();
        }
        
        socket.broadcast.emit('profile-updated', {
            userId,
            profilePic
        });
    });

    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp, fromUserSpecial } = data;
        
        const messageObj = {
            fromUserId,
            toUserId,
            message,
            timestamp: timestamp || new Date().toISOString(),
            type: 'text',
            messageId,
            fromUserSpecial
        };
        
        messageHistory.push(messageObj);
        saveMessagesData();
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('private-message', {
                fromUserId,
                fromName,
                message,
                timestamp: messageObj.timestamp,
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
                timestamp: messageObj.timestamp,
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
        
        const messageObj = {
            fromUserId,
            toUserId,
            audioUrl,
            duration,
            timestamp: timestamp || new Date().toISOString(),
            type: 'voice',
            messageId,
            fromUserSpecial
        };
        
        messageHistory.push(messageObj);
        saveMessagesData();
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('voice-message', {
                fromUserId,
                fromName,
                audioUrl,
                duration,
                timestamp: messageObj.timestamp,
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
                timestamp: messageObj.timestamp,
                messageId,
                fromUserSpecial
            });
        }
    });

    socket.on('file-message', (data) => {
        const { toUserId, fileUrl, fileName, fileType, fromUserId, fromName, messageId, timestamp, fromUserSpecial } = data;
        
        const messageObj = {
            fromUserId,
            toUserId,
            fileUrl,
            fileName,
            fileType,
            timestamp: timestamp || new Date().toISOString(),
            type: 'file',
            messageId,
            fromUserSpecial
        };
        
        messageHistory.push(messageObj);
        saveMessagesData();
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('file-message', {
                fromUserId,
                fromName,
                fileUrl,
                fileName,
                fileType,
                timestamp: messageObj.timestamp,
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
                timestamp: messageObj.timestamp,
                messageId,
                fromUserSpecial
            });
        }
    });

    socket.on('delete-message', (data) => {
        const { messageId, toUserId, deleteType, fromUserId, timestamp } = data;
        
        // Update in message history
        const msgIndex = messageHistory.findIndex(m => m.messageId === messageId);
        if (msgIndex !== -1) {
            if (deleteType === 'for-everyone') {
                messageHistory[msgIndex].deletedForEveryone = true;
            } else if (deleteType === 'for-me') {
                if (!messageHistory[msgIndex].deletedFor) {
                    messageHistory[msgIndex].deletedFor = [];
                }
                if (!messageHistory[msgIndex].deletedFor.includes(fromUserId)) {
                    messageHistory[msgIndex].deletedFor.push(fromUserId);
                }
            }
            saveMessagesData();
        }
        
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
        
        // Update read status in message history
        const msgIndex = messageHistory.findIndex(m => m.messageId === messageId);
        if (msgIndex !== -1) {
            messageHistory[msgIndex].read = true;
            messageHistory[msgIndex].readAt = new Date().toISOString();
            saveMessagesData();
        }
        
        if (users.has(fromUserId)) {
            io.to(fromUserId).emit('message-read', {
                messageId,
                fromUserId: toUserId
            });
        }
    });

    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
        
        // Update all messages from this user as read
        messageHistory.forEach(msg => {
            if (msg.fromUserId === fromUserId && msg.toUserId === toUserId && !msg.read) {
                msg.read = true;
                msg.readAt = new Date().toISOString();
            }
        });
        saveMessagesData();
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('messages-read', {
                fromUserId
            });
        }
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
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-answer', { answer, fromUserId });
        }
    });

    socket.on('ice-candidate', (data) => {
        const { toUserId, candidate, fromUserId } = data;
        if (users.has(toUserId)) {
            io.to(toUserId).emit('ice-candidate', { candidate, fromUserId });
        }
    });

    socket.on('call-end', (data) => {
        const { toUserId, fromUserId } = data;
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-end', { fromUserId });
        }
    });

    socket.on('call-busy', (data) => {
        const { toUserId } = data;
        if (users.has(toUserId)) {
            io.to(toUserId).emit('call-busy');
        }
    });

    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        
        // Update in allUsers
        if (allUsers.has(userId)) {
            const user = allUsers.get(userId);
            user.lastSeen = timestamp;
            allUsers.set(userId, user);
            saveUsersData();
        }
        
        socket.broadcast.emit('last-seen-update', {
            userId,
            timestamp
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
            // Remove from active users
            users.delete(disconnectedUserId);
            
            // Update last seen in allUsers
            if (allUsers.has(disconnectedUserId)) {
                const user = allUsers.get(disconnectedUserId);
                user.lastSeen = new Date().toISOString();
                allUsers.set(disconnectedUserId, user);
                saveUsersData();
            }
            
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
    console.log(`✅ HJH Chat app running on port ${PORT}`);
    console.log(`✅ Admin panel: /harisjutttt`);
    console.log(`✅ Admin Key: ${ADMIN_KEY}`);
    console.log(`✅ Total registered users: ${allUsers.size}`);
    console.log(`✅ Total messages: ${messageHistory.length}`);
    console.log(`✅ Total files: ${filesList.length}`);
});
