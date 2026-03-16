const socket = io({
    secure: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling']
});

let currentUser = null;
let selectedUser = null;
let typingTimeout = null;
let blockedUsers = [];
let allUsers = [];
let unreadMessages = new Map();
let messageQueue = new Map();
let searchActive = false;

// Voice recording
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;

// Call variables
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callActive = false;
let pendingCall = null;
let callType = null;
let callStartTime = null;
let callTimer = null;

// Delete feature variables
let selectedMessageForDelete = null;
let deleteMenuTimeout = null;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// ========== Toast Notifications ==========
function showToast(message, type = 'error') {
    const existingToast = document.querySelector('.custom-toast');
    if (existingToast) existingToast.remove();
    
    const toast = document.createElement('div');
    toast.className = `custom-toast ${type}`;
    
    let icon = 'fa-circle-exclamation';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'warning') icon = 'fa-triangle-exclamation';
    if (type === 'info') icon = 'fa-circle-info';
    
    toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========== Get Device Info ==========
async function getDeviceInfo() {
    try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const ip = ipData.ip;
        
        const userAgent = navigator.userAgent;
        const screenRes = `${screen.width}x${screen.height}x${screen.colorDepth}`;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const language = navigator.language;
        const platform = navigator.platform;
        const hardwareConcurrency = navigator.hardwareConcurrency || 'unknown';
        const deviceMemory = navigator.deviceMemory || 'unknown';
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        
        const fingerprint = `${ip}-${userAgent}-${screenRes}-${timeZone}-${language}-${platform}-${hardwareConcurrency}-${deviceMemory}-${timestamp}-${random}`;
        const deviceId = btoa(unescape(encodeURIComponent(fingerprint))).substring(0, 25).replace(/[^a-zA-Z0-9]/g, '');
        
        return { ip, deviceId, userAgent, platform, timestamp };
    } catch (error) {
        const randomStr = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        const deviceId = `dev_${randomStr.substring(0, 20)}`;
        return { ip: 'unknown', deviceId, userAgent: navigator.userAgent, platform: navigator.platform, timestamp: Date.now() };
    }
}

// ========== Generate User ID ==========
async function generateUniqueUserId() {
    let permanentUserId = localStorage.getItem('hj-permanent-user-id');
    if (permanentUserId) return permanentUserId;
    
    let deviceId = localStorage.getItem('hj-device-id');
    if (!deviceId) {
        const deviceInfo = await getDeviceInfo();
        deviceId = deviceInfo.deviceId;
        localStorage.setItem('hj-device-id', deviceId);
        localStorage.setItem('hj-device-ip', deviceInfo.ip);
        localStorage.setItem('hj-device-platform', deviceInfo.platform);
    }
    
    const installationId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem('hj-installation-id', installationId);
    
    const permanentId = `usr_${deviceId}_${installationId.substring(0, 8)}`;
    localStorage.setItem('hj-permanent-user-id', permanentId);
    localStorage.setItem('hj-device-installation', installationId);
    
    return permanentId;
}

// ========== Load/Save User Data ==========
function loadUserData() {
    const saved = localStorage.getItem('hj-user-data');
    return saved ? JSON.parse(saved) : null;
}

function saveUserData(userData) {
    localStorage.setItem('hj-user-data', JSON.stringify(userData));
}

// ========== Chat History ==========
function loadChatHistory(userId) {
    if (!currentUser) return [];
    const history = localStorage.getItem(`chat_${currentUser.userId}_${userId}`);
    return history ? JSON.parse(history) : [];
}

function saveMessageToHistory(toUserId, messageData) {
    if (!currentUser) return;
    const key = `chat_${currentUser.userId}_${toUserId}`;
    const history = loadChatHistory(toUserId);
    history.push(messageData);
    localStorage.setItem(key, JSON.stringify(history));
    return messageData.messageId;
}

function updateMessageInHistory(toUserId, messageId, updates) {
    if (!currentUser) return;
    const key = `chat_${currentUser.userId}_${toUserId}`;
    const history = loadChatHistory(toUserId);
    const index = history.findIndex(msg => msg.messageId === messageId);
    if (index !== -1) {
        history[index] = { ...history[index], ...updates };
        localStorage.setItem(key, JSON.stringify(history));
    }
}

function loadMessagesWithUser(userId) {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    
    const history = loadChatHistory(userId);
    history.forEach(msg => {
        if (msg.type === 'voice') {
            displayVoiceMessage({ ...msg, fromName: msg.fromName });
        } else if (msg.type === 'file') {
            displayFileMessage({ ...msg, fromName: msg.fromName });
        } else {
            displayMessage(msg.fromName, msg.message, msg.fromName === 'You' ? 'sent' : 'received', msg.timestamp, msg.messageId, msg);
        }
    });
}

// ========== Profile Picture ==========
function uploadProfilePicture() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const data = await res.json();
            
            currentUser.profilePic = data.fileUrl;
            saveUserData(currentUser);
            
            const profilePicDiv = document.getElementById('profile-pic');
            profilePicDiv.innerHTML = `<img src="${data.fileUrl}" alt="Profile">`;
            
            updateUserProfilePic(currentUser.userId, data.fileUrl);
            socket.emit('update-profile', { userId: currentUser.userId, profilePic: data.fileUrl });
            
        } catch (error) {
            showToast('Failed to upload profile picture', 'error');
        }
    };
    input.click();
}

function updateUserProfilePic(userId, profilePic) {
    const userItem = document.getElementById(`user-${userId}`);
    if (userItem) {
        const avatar = userItem.querySelector('.user-avatar');
        if (avatar) avatar.innerHTML = `<img src="${profilePic}" alt="Profile">`;
    }
}

// ========== Block/Unblock ==========
function blockUser(userId, userName) {
    if (!blockedUsers.includes(userId)) {
        blockedUsers.push(userId);
        localStorage.setItem('hj-blocked-users', JSON.stringify(blockedUsers));
        showToast(`${userName} has been blocked`, 'success');
        updateBlockButton(userId, true);
    }
}

function unblockUser(userId, userName) {
    const index = blockedUsers.indexOf(userId);
    if (index > -1) {
        blockedUsers.splice(index, 1);
        localStorage.setItem('hj-blocked-users', JSON.stringify(blockedUsers));
        showToast(`${userName} has been unblocked`, 'success');
        updateBlockButton(userId, false);
    }
}

function updateBlockButton(userId, isBlocked) {
    const userItem = document.getElementById(`user-${userId}`);
    if (!userItem) return;
    
    const existingBtn = userItem.querySelector('.block-btn');
    if (existingBtn) existingBtn.remove();
    
    const blockBtn = document.createElement('button');
    blockBtn.className = 'block-btn';
    blockBtn.innerHTML = isBlocked ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-ban"></i>';
    blockBtn.title = isBlocked ? 'Unblock' : 'Block';
    blockBtn.onclick = (e) => {
        e.stopPropagation();
        if (isBlocked) {
            unblockUser(userId, userItem.querySelector('h4').textContent);
        } else {
            blockUser(userId, userItem.querySelector('h4').textContent);
        }
    };
    userItem.appendChild(blockBtn);
}

// ========== Global Search ==========
function toggleGlobalSearch() {
    const searchBar = document.getElementById('global-search-bar');
    if (searchBar) {
        searchBar.remove();
        searchActive = false;
    } else {
        showGlobalSearchBar();
    }
}

function showGlobalSearchBar() {
    const existingBar = document.getElementById('global-search-bar');
    if (existingBar) existingBar.remove();
    
    const searchBar = document.createElement('div');
    searchBar.id = 'global-search-bar';
    searchBar.className = 'global-search-bar';
    searchBar.innerHTML = `
        <div class="search-header">
            <h4><i class="fas fa-globe"></i> Search Users</h4>
            <button onclick="toggleGlobalSearch()" class="close-search"><i class="fas fa-times"></i></button>
        </div>
        <div class="search-input-wrapper">
            <i class="fas fa-search"></i>
            <input type="text" id="global-search-input" placeholder="Search by name or user ID..." autofocus>
        </div>
        <div id="search-results" class="search-results">
            <div class="search-hint">Type at least 2 characters to search</div>
        </div>
    `;
    
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.prepend(searchBar);
        searchActive = true;
        
        const input = document.getElementById('global-search-input');
        if (input) {
            input.addEventListener('input', debounce(performGlobalSearch, 300));
            input.focus();
        }
        socket.emit('get-all-users');
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function performGlobalSearch() {
    const input = document.getElementById('global-search-input');
    if (!input) return;
    
    const query = input.value.trim().toLowerCase();
    const resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;
    
    if (query.length < 2) {
        resultsDiv.innerHTML = '<div class="search-hint">Type at least 2 characters to search</div>';
        return;
    }
    
    resultsDiv.innerHTML = '<div class="search-loading"><i class="fas fa-spinner fa-spin"></i> Searching...</div>';
    
    if (allUsers.length > 0) {
        const filtered = allUsers.filter(user => 
            user.userId !== currentUser?.userId &&
            (user.name.toLowerCase().includes(query) || user.userId.toLowerCase().includes(query))
        );
        displaySearchResults(filtered);
    }
    
    socket.emit('search-users', { query, currentUserId: currentUser?.userId });
}

function displaySearchResults(users) {
    const resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;
    
    if (!users || users.length === 0) {
        resultsDiv.innerHTML = '<div class="no-results">No users found</div>';
        return;
    }
    
    let html = '';
    users.forEach(user => {
        if (user.userId === currentUser?.userId) return;
        
        const isOnline = isUserOnline(user.userId);
        const statusClass = isOnline ? 'online' : 'offline';
        const statusText = isOnline ? 'Online' : 'Offline';
        const hasUnread = unreadMessages.has(user.userId);
        
        html += `
            <div class="search-result-item" onclick="startChatWithUser('${user.userId}', '${user.name}')">
                <div class="result-avatar">
                    ${user.profilePic ? `<img src="${user.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>'}
                </div>
                <div class="result-info">
                    <div class="result-name">
                        ${user.name}
                        ${hasUnread ? '<span class="unread-badge-small">●</span>' : ''}
                    </div>
                    <div class="result-id">${user.userId}</div>
                </div>
                <div class="result-status ${statusClass}">
                    <i class="fas fa-circle"></i> ${statusText}
                </div>
            </div>
        `;
    });
    
    resultsDiv.innerHTML = html;
}

function startChatWithUser(userId, userName) {
    if (!document.getElementById(`user-${userId}`)) {
        addUserToList({ userId, name: userName, profilePic: null, online: isUserOnline(userId) });
    }
    selectUser({ userId, name: userName, profilePic: null });
    toggleGlobalSearch();
    showToast(`Chat started with ${userName}`, 'success');
}

// ========== Offline Message Queue ==========
function queueOfflineMessage(toUserId, messageData) {
    if (!messageQueue.has(toUserId)) messageQueue.set(toUserId, []);
    messageQueue.get(toUserId).push(messageData);
    saveMessageQueue();
}

function saveMessageQueue() {
    const queueObj = {};
    messageQueue.forEach((messages, userId) => queueObj[userId] = messages);
    localStorage.setItem('hj-message-queue', JSON.stringify(queueObj));
}

function loadMessageQueue() {
    const saved = localStorage.getItem('hj-message-queue');
    if (saved) {
        try {
            const queueObj = JSON.parse(saved);
            Object.keys(queueObj).forEach(userId => messageQueue.set(userId, queueObj[userId]));
        } catch (e) {}
    }
}

function deliverQueuedMessages(userId) {
    if (messageQueue.has(userId)) {
        const messages = messageQueue.get(userId);
        messages.forEach(msgData => {
            socket.emit('private-message', {
                toUserId: userId,
                message: msgData.message,
                fromUserId: currentUser.userId,
                fromName: currentUser.name,
                isOfflineMessage: true
            });
            saveMessageToHistory(userId, { fromName: 'You', message: msgData.message, timestamp: msgData.timestamp });
        });
        messageQueue.delete(userId);
        saveMessageQueue();
        showToast(`Messages delivered to ${userId}`, 'success');
    }
}

// ========== Push Notifications ==========
async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    if (Notification.permission !== 'denied') await Notification.requestPermission();
}

function showNotification(title, options = {}) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (options.userId && selectedUser?.userId === options.userId) return;
    
    new Notification(title, {
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        ...options
    });
    playNotificationSound();
}

function playNotificationSound() {
    const audio = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADYABvb3R0aEUgAACTQAAgQwAAUULgAABqeXBoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAD8A8AACAAAAAsAAABpAACAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAD8A8AACAAAAAsAAABpAACAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    audio.play().catch(() => {});
}

// ========== Last Seen ==========
function updateLastSeen(userId) {
    const now = new Date();
    socket.emit('update-last-seen', { userId, timestamp: now.toISOString() });
}

function getLastSeenText(timestamp) {
    if (!timestamp) return 'Offline';
    const lastSeen = new Date(timestamp);
    const now = new Date();
    const diffMins = Math.floor((now - lastSeen) / 60000);
    if (diffMins < 1) return 'Online';
    if (diffMins < 60) return `Last seen ${diffMins} min ago`;
    if (diffMins < 1440) return `Last seen ${Math.floor(diffMins/60)} hour ago`;
    if (diffMins < 2880) return 'Last seen yesterday';
    return `Last seen ${Math.floor(diffMins/1440)} days ago`;
}

// ========== Message Search ==========
let messageSearchResults = [];
let currentMessageSearchIndex = -1;

function toggleMessageSearch() {
    const searchBar = document.getElementById('message-search-bar');
    if (searchBar) {
        searchBar.remove();
    } else {
        showMessageSearchBar();
    }
}

function showMessageSearchBar() {
    const searchBar = document.createElement('div');
    searchBar.id = 'message-search-bar';
    searchBar.className = 'message-search-bar';
    searchBar.innerHTML = `
        <div class="search-input-container">
            <i class="fas fa-search"></i>
            <input type="text" id="message-search-input" placeholder="Search in conversation..." autofocus>
            <span class="search-count" id="message-search-count"></span>
            <button onclick="toggleMessageSearch()" class="search-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="search-nav">
            <button onclick="searchPrevious()" id="search-prev" disabled><i class="fas fa-chevron-up"></i></button>
            <button onclick="searchNext()" id="search-next" disabled><i class="fas fa-chevron-down"></i></button>
        </div>
    `;
    
    document.querySelector('.chat-header').after(searchBar);
    
    document.getElementById('message-search-input').addEventListener('input', performMessageSearch);
}

function performMessageSearch() {
    const query = document.getElementById('message-search-input').value.toLowerCase().trim();
    if (!query || !selectedUser) {
        resetMessageSearch();
        return;
    }
    
    const messages = document.querySelectorAll('.message');
    messageSearchResults = [];
    
    messages.forEach((msg, index) => {
        if (msg.innerText.toLowerCase().includes(query)) {
            messageSearchResults.push(index);
            msg.classList.add('search-highlight');
        } else {
            msg.classList.remove('search-highlight');
        }
    });
    
    updateMessageSearchNavigation();
}

function updateMessageSearchNavigation() {
    const countSpan = document.getElementById('message-search-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');
    
    if (messageSearchResults.length === 0) {
        countSpan.textContent = 'No results';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        currentMessageSearchIndex = -1;
    } else {
        currentMessageSearchIndex = 0;
        countSpan.textContent = `1/${messageSearchResults.length}`;
        prevBtn.disabled = true;
        nextBtn.disabled = messageSearchResults.length <= 1;
        scrollToMessageSearchResult(0);
    }
}

function searchNext() {
    if (messageSearchResults.length === 0) return;
    if (currentMessageSearchIndex < messageSearchResults.length - 1) {
        currentMessageSearchIndex++;
        updateMessageSearchNavButtons();
        scrollToMessageSearchResult(currentMessageSearchIndex);
    }
}

function searchPrevious() {
    if (messageSearchResults.length === 0) return;
    if (currentMessageSearchIndex > 0) {
        currentMessageSearchIndex--;
        updateMessageSearchNavButtons();
        scrollToMessageSearchResult(currentMessageSearchIndex);
    }
}

function updateMessageSearchNavButtons() {
    const countSpan = document.getElementById('message-search-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');
    
    countSpan.textContent = `${currentMessageSearchIndex + 1}/${messageSearchResults.length}`;
    prevBtn.disabled = currentMessageSearchIndex <= 0;
    nextBtn.disabled = currentMessageSearchIndex >= messageSearchResults.length - 1;
}

function scrollToMessageSearchResult(index) {
    const messages = document.querySelectorAll('.message');
    messages[messageSearchResults[index]].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetMessageSearch() {
    messageSearchResults = [];
    currentMessageSearchIndex = -1;
    document.querySelectorAll('.message').forEach(msg => msg.classList.remove('search-highlight'));
    const countSpan = document.getElementById('message-search-count');
    if (countSpan) countSpan.textContent = '';
}

// ========== READ RECEIPTS (Blue Ticks) ==========
function markMessageAsRead(messageId, fromUserId) {
    if (!selectedUser || !currentUser) return;
    
    // Update UI
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (messageEl) {
        const timeEl = messageEl.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    }
    
    // Update history
    updateMessageInHistory(fromUserId, messageId, { read: true, readAt: new Date().toISOString() });
    
    // Notify sender
    socket.emit('message-read', {
        messageId: messageId,
        fromUserId: fromUserId,
        toUserId: currentUser.userId
    });
}

function markAllMessagesAsRead(fromUserId) {
    if (!selectedUser || !currentUser) return;
    
    const messages = document.querySelectorAll('.message.received');
    messages.forEach(msg => {
        const timeEl = msg.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    });
    
    socket.emit('messages-read', {
        toUserId: fromUserId,
        fromUserId: currentUser.userId
    });
}

// ========== FIXED: Call Functions ==========
function startVideoCall() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    startCall('video');
}

function startVoiceCall() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    startCall('voice');
}

async function startCall(type) {
    try {
        if (callActive) {
            showToast('Call already in progress', 'warning');
            return;
        }
        
        if (!selectedUser) {
            showToast('Select a contact first', 'info');
            return;
        }
        
        // Check if user is online
        if (!isUserOnline(selectedUser.userId)) {
            showToast('User is offline', 'warning');
            return;
        }
        
        callType = type;
        
        const constraints = { 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 2,
                sampleRate: 48000
            }
        };
        
        if (type === 'video') {
            constraints.video = {
                width: { ideal: 640, min: 320 },
                height: { ideal: 480, min: 240 },
                facingMode: 'user',
                frameRate: { ideal: 20, min: 10 }
            };
        }
        
        showToast(`Requesting ${type === 'video' ? 'camera' : 'microphone'} access...`, 'info');
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Local stream obtained:', localStream.getTracks().length, 'tracks');
        } catch (err) {
            console.error('Media device error:', err);
            let errorMessage = 'Failed to access media devices';
            if (err.name === 'NotAllowedError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} access denied. Please allow permissions.`;
            } else if (err.name === 'NotFoundError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} not found.`;
            } else if (err.name === 'NotReadableError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} is already in use by another app.`;
            }
            showToast(errorMessage, 'error');
            return;
        }
        
        showCallDialog(`Calling ${selectedUser.name}...`, 'outgoing');
        
        peerConnection = new RTCPeerConnection({
            iceServers: configuration.iceServers,
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        // Add local tracks to peer connection
        localStream.getTracks().forEach(track => {
            console.log('Adding track:', track.kind, track.enabled);
            peerConnection.addTrack(track, localStream);
        });
        
        // Handle remote stream
        peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            // Show call screen when we have remote tracks
            if (remoteStream.getTracks().length > 0) {
                showCallScreen(type);
                
                // Attach remote stream to video/audio elements
                setTimeout(() => {
                    if (type === 'video') {
                        const remoteVideo = document.getElementById('remote-video');
                        if (remoteVideo) {
                            remoteVideo.srcObject = remoteStream;
                            remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                        }
                    } else {
                        // For audio calls, just play audio
                        const audio = new Audio();
                        audio.srcObject = remoteStream;
                        audio.play().catch(e => console.log('Audio play error:', e));
                    }
                }, 500);
            }
        };
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate');
                socket.emit('ice-candidate', { 
                    toUserId: selectedUser.userId, 
                    candidate: event.candidate,
                    fromUserId: currentUser.userId
                });
            }
        };
        
        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                document.getElementById('call-dialog')?.remove();
                callStartTime = Date.now();
                startCallTimer();
            } else if (peerConnection.connectionState === 'disconnected' || 
                       peerConnection.connectionState === 'failed' ||
                       peerConnection.connectionState === 'closed') {
                showToast('Call disconnected', 'warning');
                endCall();
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
        };
        
        peerConnection.onsignalingstatechange = () => {
            console.log('Signaling state:', peerConnection.signalingState);
        };
        
        // Create and send offer
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: type === 'video'
        });
        
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created, waiting for answer');
        
        socket.emit('call-offer', { 
            toUserId: selectedUser.userId, 
            offer: offer,
            callType: type,
            fromUserId: currentUser.userId,
            fromName: currentUser.name
        });
        
        callActive = true;
        
    } catch (error) {
        console.error('Call error:', error);
        showToast('Failed to start call: ' + error.message, 'error');
        endCall();
    }
}

function showCallDialog(message, type) {
    const existingDialog = document.getElementById('call-dialog');
    if (existingDialog) existingDialog.remove();
    
    const dialog = document.createElement('div');
    dialog.className = 'call-dialog';
    dialog.id = 'call-dialog';
    dialog.innerHTML = `
        <div class="call-dialog-content">
            <div class="call-spinner"></div>
            <p>${message}</p>
            <button onclick="endCall()" class="end-call-btn"><i class="fas fa-phone-slash"></i> End</button>
        </div>
    `;
    document.body.appendChild(dialog);
}

function showCallScreen(type) {
    document.getElementById('call-dialog')?.remove();
    
    const existingScreen = document.getElementById('call-screen');
    if (existingScreen) existingScreen.remove();
    
    const callScreen = document.createElement('div');
    callScreen.className = 'call-screen';
    callScreen.id = 'call-screen';
    
    if (type === 'video') {
        callScreen.innerHTML = `
            <div class="call-container video">
                <div class="remote-video-container">
                    <video id="remote-video" autoplay playsinline></video>
                    <div class="call-info">
                        <h3>${selectedUser?.name || 'User'}</h3>
                        <p class="call-timer" id="call-timer">00:00</p>
                    </div>
                </div>
                <div class="local-video-container">
                    <video id="local-video" autoplay playsinline muted></video>
                </div>
                <div class="call-controls">
                    <button onclick="toggleMute()" id="mute-btn" class="call-control-btn"><i class="fas fa-microphone"></i></button>
                    <button onclick="toggleVideo()" id="video-btn" class="call-control-btn"><i class="fas fa-video"></i></button>
                    <button onclick="endCall()" class="call-control-btn end-call"><i class="fas fa-phone-slash"></i></button>
                </div>
            </div>
        `;
    } else {
        callScreen.innerHTML = `
            <div class="call-container audio">
                <div class="audio-call-container">
                    <div class="call-avatar">
                        ${selectedUser?.profilePic ? 
                            `<img src="${selectedUser.profilePic}" alt="Profile">` : 
                            '<i class="fas fa-user-circle"></i>'}
                    </div>
                    <h2>${selectedUser?.name || 'User'}</h2>
                    <p class="call-timer" id="call-timer">00:00</p>
                </div>
                <div class="call-controls">
                    <button onclick="toggleMute()" id="mute-btn" class="call-control-btn"><i class="fas fa-microphone"></i></button>
                    <button onclick="endCall()" class="call-control-btn end-call"><i class="fas fa-phone-slash"></i></button>
                </div>
            </div>
        `;
    }
    
    document.body.appendChild(callScreen);
    
    // Attach local video if video call
    if (type === 'video') {
        setTimeout(() => {
            const localVideo = document.getElementById('local-video');
            if (localVideo && localStream) {
                localVideo.srcObject = localStream;
                localVideo.play().catch(e => console.log('Local video play error:', e));
            }
        }, 100);
    }
}

function startCallTimer() {
    if (callTimer) clearInterval(callTimer);
    
    callTimer = setInterval(() => {
        if (!callStartTime) return;
        
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timerStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        const timerEl = document.getElementById('call-timer');
        if (timerEl) timerEl.textContent = timerStr;
    }, 1000);
}

function endCall() {
    console.log('Ending call');
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log('Stopped track:', track.kind);
        });
        localStream = null;
    }
    
    remoteStream = null;
    
    document.getElementById('call-dialog')?.remove();
    document.getElementById('call-screen')?.remove();
    
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    if (selectedUser && currentUser) {
        socket.emit('call-end', { 
            toUserId: selectedUser.userId, 
            fromUserId: currentUser.userId 
        });
    }
    
    callActive = false;
    callStartTime = null;
    callType = null;
}

function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const btn = document.getElementById('mute-btn');
            if (btn) {
                btn.innerHTML = audioTrack.enabled ? 
                    '<i class="fas fa-microphone"></i>' : 
                    '<i class="fas fa-microphone-slash"></i>';
                btn.classList.toggle('muted', !audioTrack.enabled);
            }
            showToast(audioTrack.enabled ? 'Microphone unmuted' : 'Microphone muted', 'info');
        }
    }
}

function toggleVideo() {
    if (localStream && callType === 'video') {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            const btn = document.getElementById('video-btn');
            if (btn) {
                btn.innerHTML = videoTrack.enabled ? 
                    '<i class="fas fa-video"></i>' : 
                    '<i class="fas fa-video-slash"></i>';
                btn.classList.toggle('video-off', !videoTrack.enabled);
            }
            showToast(videoTrack.enabled ? 'Camera turned on' : 'Camera turned off', 'info');
        }
    }
}

// ========== Add user to list with online/offline separation ==========
function addUserToList(user) {
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    if (!onlineList || !offlineList) return;
    
    // Don't add current user
    if (currentUser && user.userId === currentUser.userId) return;
    
    // Check if already exists
    if (document.getElementById(`user-${user.userId}`)) return;
    
    const isOnline = user.online || false;
    const history = currentUser ? loadChatHistory(user.userId) : [];
    const unread = history.filter(msg => msg.fromName !== 'You').length;
    const isBlocked = blockedUsers.includes(user.userId);
    
    const userDiv = document.createElement('div');
    userDiv.className = 'user-item';
    userDiv.id = `user-${user.userId}`;
    userDiv.onclick = () => selectUser(user);
    
    // Set online/offline status
    const statusColor = isOnline ? '#4caf50' : '#f44336';
    const statusText = isOnline ? 'Online' : 'Offline';
    
    userDiv.innerHTML = `
        <div class="user-avatar" id="avatar-${user.userId}">
            ${user.profilePic ? `<img src="${user.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>'}
        </div>
        <div class="user-info">
            <h4>${user.name} ${unread > 0 ? `<span class="unread-badge" style="background:#ff4444;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:5px;">${unread}</span>` : ''}</h4>
            <p><i class="fas fa-circle" style="color:${statusColor};"></i> ${statusText}</p>
        </div>
    `;
    
    // Add to appropriate list
    if (isOnline) {
        onlineList.appendChild(userDiv);
    } else {
        offlineList.appendChild(userDiv);
    }
    
    updateBlockButton(user.userId, isBlocked);
}

// ========== Update online/offline status ==========
function updateUserStatus(userId, isOnline) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (!userDiv) return;
    
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    const statusEl = userDiv.querySelector('.user-info p');
    const statusColor = isOnline ? '#4caf50' : '#f44336';
    const statusText = isOnline ? 'Online' : 'Offline';
    
    statusEl.innerHTML = `<i class="fas fa-circle" style="color:${statusColor};"></i> ${statusText}`;
    
    // Move between lists
    if (isOnline) {
        if (offlineList.contains(userDiv)) {
            offlineList.removeChild(userDiv);
            onlineList.appendChild(userDiv);
        }
    } else {
        if (onlineList.contains(userDiv)) {
            onlineList.removeChild(userDiv);
            offlineList.appendChild(userDiv);
        }
    }
}

function removeUserFromList(userId) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (userDiv) userDiv.remove();
}

function isUserOnline(userId) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (!userDiv) return false;
    const statusEl = userDiv.querySelector('.user-info p');
    return statusEl.innerHTML.includes('color:#4caf50');
}

// ========== Login ==========
let pendingLogin = false;

function login() {
    if (pendingLogin) return;
    
    const name = document.getElementById('login-name').value.trim();
    const id = document.getElementById('login-userid').value.trim();
    
    if (!name || !id) { showToast('Please enter both name and ID', 'warning'); return; }
    
    pendingLogin = true;
    socket.emit('check-username', { name, userId: id, deviceId: localStorage.getItem('hj-device-id') || 'unknown' });
}

function completeLogin() {
    const name = document.getElementById('login-name').value.trim();
    const id = document.getElementById('login-userid').value.trim();
    
    currentUser = { userId: id, name, profilePic: loadUserData()?.profilePic || null };
    saveUserData(currentUser);
    localStorage.setItem('hj-device-user-id', id);
    
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    document.getElementById('current-user-name').textContent = name;
    document.getElementById('current-user-id').textContent = id;
    
    socket.emit('user-login', currentUser);
    pendingLogin = false;
    
    updateChatHeader();
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('hj-user-data');
        localStorage.removeItem('hj-device-user-id');
        
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('chat-screen').classList.remove('active');
        document.getElementById('login-name').value = '';
        document.getElementById('profile-pic').innerHTML = '<i class="fas fa-camera"></i>';
        document.getElementById('messages-container').innerHTML = '';
        selectedUser = null;
        currentUser = null;
        document.getElementById('no-chat-selected').classList.remove('hidden');
        document.getElementById('chat-with-name').textContent = 'Select Contact';
    }
}

// ========== Sidebar ==========
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('active');
}

// ========== Select user ==========
function selectUser(user) {
    selectedUser = user;
    
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`user-${user.userId}`).classList.add('active');
    
    document.getElementById('chat-with-name').textContent = user.name;
    document.getElementById('chat-with-status').innerHTML = '<i class="fas fa-circle" style="color:#4caf50;"></i> Online';
    document.getElementById('no-chat-selected').classList.add('hidden');
    
    loadMessagesWithUser(user.userId);
    
    // Mark all messages as read when opening chat
    setTimeout(() => {
        markAllMessagesAsRead(user.userId);
    }, 500);
    
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('active');
    
    setTimeout(() => document.getElementById('message-input').focus(), 300);
}

// ========== Display message with delete feature and read receipts ==========
function displayMessage(senderName, message, type, timestamp, messageId, messageData = {}) {
    const container = document.getElementById('messages-container');
    
    // Check if message exists already
    if (document.getElementById(`msg-${messageId}`)) return;
    
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.id = `msg-${messageId}`;
    
    let timeString = '';
    if (timestamp) {
        const date = new Date(timestamp);
        timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Check if message is deleted for everyone
    if (messageData.deletedForEveryone) {
        div.innerHTML = `
            ${type === 'received' ? `<div class="sender">${senderName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> This message was deleted
            </div>
            <div class="time">${timeString}</div>
        `;
        div.classList.add('deleted');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return;
    }
    
    // Check if message is deleted for current user
    if (messageData.deletedFor && messageData.deletedFor.includes(currentUser?.userId)) {
        return; // Don't show this message
    }
    
    // Add read receipt for sent messages
    const readReceipt = (type === 'sent' && messageData.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    // Regular message with delete button (only for sent messages)
    const deleteButton = type === 'sent' ? `
        <button class="message-delete-btn" onclick="showDeleteMenu('${messageId}', event)">
            <i class="fas fa-ellipsis-v"></i>
        </button>
    ` : '';
    
    div.innerHTML = `
        ${type === 'received' ? `<div class="sender">${senderName}</div>` : ''}
        <div class="message-content">${message}</div>
        <div class="message-footer">
            <span class="time">${timeString}${readReceipt}</span>
            ${deleteButton}
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    // If this is a received message and chat is open, mark as read
    if (type === 'received' && selectedUser && selectedUser.userId === messageData.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(messageId, messageData.fromUserId);
        }, 1000);
    }
}

// ========== Send message ==========
function sendMessage() {
    const input = document.getElementById('message-input');
    const msg = input.value.trim();
    
    if (!msg || !selectedUser) {
        if (!selectedUser) showToast('Select a contact first', 'info');
        return;
    }
    
    if (blockedUsers.includes(selectedUser.userId)) {
        showToast('You have blocked this user. Unblock to send messages.', 'warning');
        return;
    }
    
    const messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const timestamp = new Date().toISOString();
    
    const messageData = { 
        fromName: 'You', 
        message: msg, 
        timestamp: timestamp,
        messageId: messageId,
        deletedFor: [],
        deletedForEveryone: false,
        read: false,
        delivered: false
    };
    
    displayMessage('You', msg, 'sent', timestamp, messageId, messageData);
    saveMessageToHistory(selectedUser.userId, messageData);
    
    if (isUserOnline(selectedUser.userId)) {
        socket.emit('private-message', { 
            toUserId: selectedUser.userId, 
            message: msg, 
            fromUserId: currentUser.userId, 
            fromName: currentUser.name,
            messageId: messageId,
            timestamp: timestamp
        });
    } else {
        queueOfflineMessage(selectedUser.userId, { 
            message: msg, 
            timestamp: timestamp,
            messageId: messageId
        });
        showToast('User is offline. Message will be delivered when they come online.', 'info');
    }
    
    input.value = '';
    input.focus();
}

// ========== Delete Message Functions ==========
function showDeleteMenu(messageId, event) {
    event.stopPropagation();
    
    // Close any open menu
    closeDeleteMenu();
    
    selectedMessageForDelete = messageId;
    
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (!messageElement) return;
    
    const menu = document.createElement('div');
    menu.className = 'delete-menu';
    menu.id = `delete-menu-${messageId}`;
    
    // Check if message is within 5 minutes (for delete for everyone)
    const history = selectedUser ? loadChatHistory(selectedUser.userId) : [];
    const messageData = history.find(msg => msg.messageId === messageId);
    
    const canDeleteForEveryone = messageData && canDeleteMessage(messageData.timestamp);
    
    menu.innerHTML = `
        <div class="delete-menu-header">
            <i class="fas fa-trash"></i> Delete Message
        </div>
        <div class="delete-menu-options">
            <button onclick="deleteForMe('${messageId}')" class="delete-option">
                <i class="fas fa-user-slash"></i> Delete for me
            </button>
            ${canDeleteForEveryone ? `
                <button onclick="deleteForEveryone('${messageId}')" class="delete-option delete-for-all">
                    <i class="fas fa-users-slash"></i> Delete for everyone
                </button>
            ` : ''}
        </div>
    `;
    
    // Position the menu
    const rect = messageElement.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.top - 10}px`;
    menu.style.left = `${rect.right - 200}px`;
    
    document.body.appendChild(menu);
    
    // Auto close after 5 seconds
    deleteMenuTimeout = setTimeout(closeDeleteMenu, 5000);
}

function closeDeleteMenu() {
    const existingMenu = document.querySelector('.delete-menu');
    if (existingMenu) existingMenu.remove();
    if (deleteMenuTimeout) clearTimeout(deleteMenuTimeout);
    selectedMessageForDelete = null;
}

function canDeleteMessage(timestamp) {
    const messageTime = new Date(timestamp).getTime();
    const now = new Date().getTime();
    const diffMinutes = (now - messageTime) / (1000 * 60);
    return diffMinutes <= 5;
}

function deleteForMe(messageId) {
    if (!selectedUser || !currentUser) return;
    
    closeDeleteMenu();
    
    if (!confirm('Delete this message for you?')) return;
    
    // Load history
    const history = loadChatHistory(selectedUser.userId);
    const messageIndex = history.findIndex(msg => msg.messageId === messageId);
    
    if (messageIndex === -1) return;
    
    // Add current user to deletedFor array
    if (!history[messageIndex].deletedFor) {
        history[messageIndex].deletedFor = [];
    }
    
    if (!history[messageIndex].deletedFor.includes(currentUser.userId)) {
        history[messageIndex].deletedFor.push(currentUser.userId);
    }
    
    // Save updated history
    const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
    localStorage.setItem(key, JSON.stringify(history));
    
    // Remove message from UI
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (messageElement) {
        messageElement.remove();
    }
    
    // Notify server (for multi-device sync)
    socket.emit('delete-message', {
        messageId: messageId,
        toUserId: selectedUser.userId,
        deleteType: 'for-me',
        fromUserId: currentUser.userId,
        timestamp: new Date().toISOString()
    });
    
    showToast('Message deleted', 'success');
}

function deleteForEveryone(messageId) {
    if (!selectedUser || !currentUser) return;
    
    closeDeleteMenu();
    
    if (!confirm('Delete this message for everyone? This cannot be undone!')) return;
    
    // Load history
    const history = loadChatHistory(selectedUser.userId);
    const messageIndex = history.findIndex(msg => msg.messageId === messageId);
    
    if (messageIndex === -1) return;
    
    // Check if still within time limit
    if (!canDeleteMessage(history[messageIndex].timestamp)) {
        showToast('Cannot delete message after 5 minutes', 'warning');
        return;
    }
    
    // Mark as deleted for everyone
    history[messageIndex].deletedForEveryone = true;
    history[messageIndex].deletedAt = new Date().toISOString();
    
    // Save updated history
    const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
    localStorage.setItem(key, JSON.stringify(history));
    
    // Update UI
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (messageElement) {
        const timeElement = messageElement.querySelector('.time');
        const timeText = timeElement ? timeElement.textContent : '';
        
        messageElement.innerHTML = `
            <div class="deleted-message">
                <i class="fas fa-trash"></i> This message was deleted
            </div>
            <div class="time">${timeText}</div>
        `;
        messageElement.classList.add('deleted');
    }
    
    // Notify server
    socket.emit('delete-message', {
        messageId: messageId,
        toUserId: selectedUser.userId,
        deleteType: 'for-everyone',
        fromUserId: currentUser.userId,
        timestamp: new Date().toISOString()
    });
    
    showToast('Message deleted for everyone', 'success');
}

// ========== Voice recording ==========
async function startVoiceRecording() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = () => stream.getTracks().forEach(t => t.stop());
        
        mediaRecorder.start();
        recordingStartTime = Date.now();
        
        document.getElementById('message-input-area').style.display = 'none';
        document.getElementById('voice-recording').classList.add('active');
        
        recordingTimer = setInterval(() => {
            const sec = Math.floor((Date.now() - recordingStartTime) / 1000);
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            document.getElementById('recording-time').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }, 1000);
        
    } catch (err) {
        showToast('Microphone access denied', 'error');
    }
}

function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    clearInterval(recordingTimer);
    document.getElementById('voice-recording').classList.remove('active');
    document.getElementById('message-input-area').style.display = 'flex';
    document.getElementById('message-input').focus();
}

async function sendVoiceMessage() {
    if (!mediaRecorder || !selectedUser) return;
    
    mediaRecorder.stop();
    clearInterval(recordingTimer);
    
    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
        
        const formData = new FormData();
        formData.append('file', blob, 'voice.webm');
        
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        
        const messageId = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const messageData = { 
            fromName: 'You', 
            type: 'voice', 
            audioUrl: data.fileUrl, 
            duration, 
            timestamp: new Date().toISOString(),
            messageId: messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: false
        };
        
        displayVoiceMessage({ fromName: 'You', audioUrl: data.fileUrl, duration, timestamp: messageData.timestamp, messageId: messageId });
        saveMessageToHistory(selectedUser.userId, messageData);
        
        socket.emit('voice-message', { 
            toUserId: selectedUser.userId, 
            audioUrl: data.fileUrl, 
            duration, 
            fromUserId: currentUser.userId, 
            fromName: currentUser.name,
            messageId: messageId,
            timestamp: messageData.timestamp
        });
        
        document.getElementById('voice-recording').classList.remove('active');
        document.getElementById('message-input-area').style.display = 'flex';
        document.getElementById('message-input').focus();
    };
}

function displayVoiceMessage(data) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    const isSent = data.fromName === 'You';
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.id = `msg-${data.messageId}`;
    
    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const m = Math.floor(data.duration / 60);
    const s = data.duration % 60;
    
    // Add read receipt for sent messages
    const readReceipt = (isSent && data.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    // Check if deleted
    if (data.deletedForEveryone) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> Voice message deleted
            </div>
            <div class="time">${time}</div>
        `;
        div.classList.add('deleted');
    } else {
        const deleteButton = isSent ? `
            <button class="message-delete-btn" onclick="showDeleteMenu('${data.messageId}', event)">
                <i class="fas fa-ellipsis-v"></i>
            </button>
        ` : '';
        
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="voice-message">
                <audio controls src="${data.audioUrl}"></audio>
                <span>${m}:${s.toString().padStart(2, '0')}</span>
            </div>
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                ${deleteButton}
            </div>
        `;
    }
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    // If received message and chat open, mark as read
    if (!isSent && selectedUser && selectedUser.userId === data.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
    }
}

// ========== File sharing ==========
function sendPhoto() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    const input = document.getElementById('file-input');
    input.accept = 'image/*';
    input.click();
}

function sendFile() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    const input = document.getElementById('file-input');
    input.accept = '*/*';
    input.click();
}

async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file || !selectedUser) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    
    const messageId = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const messageData = { 
        fromName: 'You', 
        type: 'file', 
        fileUrl: data.fileUrl, 
        fileName: data.fileName, 
        fileType: data.fileType, 
        timestamp: new Date().toISOString(),
        messageId: messageId,
        deletedFor: [],
        deletedForEveryone: false,
        read: false,
        delivered: false
    };
    
    displayFileMessage({ fromName: 'You', fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, timestamp: messageData.timestamp, messageId: messageId });
    saveMessageToHistory(selectedUser.userId, messageData);
    
    socket.emit('file-message', { 
        toUserId: selectedUser.userId, 
        fileUrl: data.fileUrl, 
        fileName: data.fileName, 
        fileType: data.fileType, 
        fromUserId: currentUser.userId, 
        fromName: currentUser.name,
        messageId: messageId,
        timestamp: messageData.timestamp
    });
}

function displayFileMessage(data) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    const isSent = data.fromName === 'You';
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.id = `msg-${data.messageId}`;
    
    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Add read receipt for sent messages
    const readReceipt = (isSent && data.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    // Check if deleted
    if (data.deletedForEveryone) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> File deleted
            </div>
            <div class="time">${time}</div>
        `;
        div.classList.add('deleted');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return;
    }
    
    let icon = 'fa-file';
    if (data.fileType.startsWith('image/')) icon = 'fa-image';
    else if (data.fileType.startsWith('audio/')) icon = 'fa-music';
    else if (data.fileType.startsWith('video/')) icon = 'fa-video';
    
    const deleteButton = isSent ? `
        <button class="message-delete-btn" onclick="showDeleteMenu('${data.messageId}', event)">
            <i class="fas fa-ellipsis-v"></i>
        </button>
    ` : '';
    
    if (data.fileType.startsWith('image/')) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <img src="${data.fileUrl}" class="image-message" onclick="window.open('${data.fileUrl}')">
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                ${deleteButton}
            </div>
        `;
    } else {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="file-message">
                <i class="fas ${icon}"></i>
                <a href="${data.fileUrl}" target="_blank">${data.fileName}</a>
            </div>
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                ${deleteButton}
            </div>
        `;
    }
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    // If received message and chat open, mark as read
    if (!isSent && selectedUser && selectedUser.userId === data.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
    }
}

// ========== Typing indicator ==========
function handleKeyPress(e) {
    if (e.key === 'Enter') { sendMessage(); return; }
    if (!selectedUser) return;
    
    socket.emit('typing', { toUserId: selectedUser.userId, fromUserId: currentUser.userId, isTyping: true });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', { toUserId: selectedUser.userId, fromUserId: currentUser.userId, isTyping: false });
    }, 1000);
}

// ========== Update chat header ==========
function updateChatHeader() {
    const actions = document.getElementById('chat-actions');
    if (!actions) return;
    
    actions.innerHTML = `
        <button class="action-btn" onclick="sendFile()" title="Send File"><i class="fas fa-paperclip"></i></button>
        <button class="action-btn" onclick="sendPhoto()" title="Send Photo"><i class="fas fa-camera"></i></button>
        <button class="action-btn video-call-btn" onclick="startVideoCall()" title="Video Call"><i class="fas fa-video"></i></button>
        <button class="action-btn voice-call-btn" onclick="startVoiceCall()" title="Voice Call"><i class="fas fa-phone"></i></button>
        <button class="action-btn search-global-btn" onclick="toggleGlobalSearch()" title="Search Users"><i class="fas fa-globe"></i></button>
        <button class="action-btn search-msg-btn" onclick="toggleMessageSearch()" title="Search in Chat"><i class="fas fa-search"></i></button>
    `;
}

// ========== Socket event handlers ==========
socket.on('connect', () => {
    console.log('✅ Connected to server');
    if (currentUser) socket.emit('user-login', currentUser);
});

socket.on('connect_error', (error) => {
    console.log('❌ Connection error:', error);
    showToast('Connection error. Please refresh.', 'error');
});

socket.on('all-users', (users) => {
    console.log('📋 All users received:', users.length);
    allUsers = users;
});

socket.on('search-results', (users) => {
    displaySearchResults(users);
});

socket.on('username-check-result', (exists) => {
    if (exists) {
        showToast('This username is already used on another device!', 'error');
        document.getElementById('login-name').value = '';
        document.getElementById('login-name').focus();
        pendingLogin = false;
    } else {
        completeLogin();
    }
});

socket.on('login-error', (message) => {
    showToast(message, 'error');
    pendingLogin = false;
    localStorage.removeItem('hj-user-data');
    localStorage.removeItem('hj-device-user-id');
    document.getElementById('login-name').value = '';
    document.getElementById('profile-pic').innerHTML = '<i class="fas fa-camera"></i>';
});

// Online users handler
socket.on('online-users', (users) => {
    console.log('📋 Online users:', users);
    
    // Clear both lists
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    if (!onlineList || !offlineList) return;
    
    onlineList.innerHTML = '';
    offlineList.innerHTML = '';
    
    // Mark online users
    const onlineUserIds = new Set(users.map(u => u.userId));
    
    // Add all users from allUsers
    if (allUsers.length > 0) {
        allUsers.forEach(user => {
            if (user.userId !== currentUser?.userId) {
                // Set online status based on socket data
                user.online = onlineUserIds.has(user.userId);
                addUserToList(user);
            }
        });
    } else {
        // If allUsers not loaded yet, just show online users
        users.forEach(user => {
            if (user.userId !== currentUser?.userId) {
                user.online = true;
                addUserToList(user);
            }
        });
    }
});

socket.on('user-online', (user) => {
    console.log('🟢 User online:', user);
    
    // Check if user exists in allUsers
    const existingUser = allUsers.find(u => u.userId === user.userId);
    if (existingUser) {
        existingUser.online = true;
    } else {
        allUsers.push({ ...user, online: true });
    }
    
    updateUserStatus(user.userId, true);
    deliverQueuedMessages(user.userId);
    if (searchActive) performGlobalSearch();
});

socket.on('user-offline', (user) => {
    console.log('🔴 User offline:', user);
    
    // Update in allUsers
    const existingUser = allUsers.find(u => u.userId === user.userId);
    if (existingUser) {
        existingUser.online = false;
    }
    
    updateUserStatus(user.userId, false);
    if (selectedUser?.userId === user.userId) {
        document.getElementById('chat-with-status').innerHTML = '<i class="fas fa-circle" style="color:#f44336;"></i> Offline';
    }
    if (searchActive) performGlobalSearch();
});

socket.on('profile-updated', (data) => {
    const userItem = document.getElementById(`user-${data.userId}`);
    if (userItem) {
        const avatar = userItem.querySelector('.user-avatar');
        if (avatar) {
            avatar.innerHTML = data.profilePic ? `<img src="${data.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>';
        }
    }
});

// FIXED: Private message handler with read receipts
socket.on('private-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    
    const timestamp = data.timestamp || new Date().toISOString();
    
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayMessage(data.fromName, data.message, 'received', timestamp, data.messageId, { 
            fromName: data.fromName,
            fromUserId: data.fromUserId,
            messageId: data.messageId 
        });
        
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            message: data.message, 
            timestamp: timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        
        // Mark as read immediately
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else {
        if (!currentUser) return;
        
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            message: data.message, 
            timestamp: timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        localStorage.setItem(key, JSON.stringify(history));
        
        const userEl = document.getElementById(`user-${data.fromUserId}`);
        if (userEl) {
            userEl.style.backgroundColor = '#fff3cd';
            setTimeout(() => userEl.style.backgroundColor = '', 2000);
            
            const unreadCount = history.filter(msg => msg.fromName !== 'You' && !msg.read).length;
            
            const h4 = userEl.querySelector('h4');
            if (h4) {
                const existingBadge = h4.querySelector('.unread-badge');
                if (existingBadge) existingBadge.remove();
                if (unreadCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.style.cssText = 'background:#ff4444;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:5px;';
                    badge.textContent = unreadCount;
                    h4.appendChild(badge);
                }
            }
        }
        
        showNotification(`New message from ${data.fromName}`, { 
            body: data.message, 
            userId: data.fromUserId 
        });
    }
});

// FIXED: Message read receipt handler
socket.on('message-read', (data) => {
    const { messageId, fromUserId } = data;
    
    // Update UI
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (messageEl) {
        const timeEl = messageEl.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    }
    
    // Update history
    if (selectedUser) {
        updateMessageInHistory(selectedUser.userId, messageId, { read: true, readAt: new Date().toISOString() });
    }
});

// FIXED: All messages read handler
socket.on('messages-read', (data) => {
    const { fromUserId } = data;
    
    if (selectedUser && selectedUser.userId === fromUserId) {
        const messages = document.querySelectorAll('.message.sent');
        messages.forEach(msg => {
            const timeEl = msg.querySelector('.time');
            if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
                timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
            }
        });
    }
});

socket.on('voice-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayVoiceMessage(data);
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            type: 'voice', 
            audioUrl: data.audioUrl, 
            duration: data.duration, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        
        // Mark as read
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else if (currentUser) {
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            type: 'voice', 
            audioUrl: data.audioUrl, 
            duration: data.duration, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        localStorage.setItem(key, JSON.stringify(history));
    }
});

socket.on('file-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayFileMessage(data);
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            type: 'file', 
            fileUrl: data.fileUrl, 
            fileName: data.fileName, 
            fileType: data.fileType, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        
        // Mark as read
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else if (currentUser) {
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            type: 'file', 
            fileUrl: data.fileUrl, 
            fileName: data.fileName, 
            fileType: data.fileType, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true
        });
        localStorage.setItem(key, JSON.stringify(history));
    }
});

// Delete message handler
socket.on('message-deleted', (data) => {
    if (!selectedUser) return;
    
    if (data.deleteType === 'for-everyone') {
        // Update UI for deleted message
        const messageEl = document.getElementById(`msg-${data.messageId}`);
        if (messageEl) {
            const timeElement = messageEl.querySelector('.time');
            const timeText = timeElement ? timeElement.textContent : '';
            
            messageEl.innerHTML = `
                <div class="deleted-message">
                    <i class="fas fa-trash"></i> This message was deleted
                </div>
                <div class="time">${timeText}</div>
            `;
            messageEl.classList.add('deleted');
        }
        
        // Update local storage
        const history = loadChatHistory(selectedUser.userId);
        const msgIndex = history.findIndex(m => m.messageId === data.messageId);
        if (msgIndex !== -1) {
            history[msgIndex].deletedForEveryone = true;
            const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
            localStorage.setItem(key, JSON.stringify(history));
        }
    }
    else if (data.deleteType === 'for-me' && data.fromUserId === currentUser?.userId) {
        // Remove message for this user on other devices
        const messageEl = document.getElementById(`msg-${data.messageId}`);
        if (messageEl) messageEl.remove();
        
        // Update local storage
        const history = loadChatHistory(selectedUser.userId);
        const msgIndex = history.findIndex(m => m.messageId === data.messageId);
        if (msgIndex !== -1) {
            if (!history[msgIndex].deletedFor) {
                history[msgIndex].deletedFor = [];
            }
            if (!history[msgIndex].deletedFor.includes(currentUser.userId)) {
                history[msgIndex].deletedFor.push(currentUser.userId);
            }
            const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
            localStorage.setItem(key, JSON.stringify(history));
        }
    }
});

socket.on('typing-indicator', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        const status = document.getElementById('chat-with-status');
        status.innerHTML = data.isTyping ? '<i class="fas fa-pencil-alt"></i> typing...' : '<i class="fas fa-circle" style="color:#4caf50;"></i> Online';
    }
});

// FIXED: Call offer handler
socket.on('call-offer', async (data) => {
    console.log('📞 Incoming call:', data);
    
    if (callActive) {
        socket.emit('call-busy', { toUserId: data.fromUserId });
        return;
    }
    
    pendingCall = {
        fromUserId: data.fromUserId,
        fromName: data.fromName,
        offer: data.offer,
        callType: data.callType
    };
    
    const callDialog = document.createElement('div');
    callDialog.className = 'call-dialog incoming';
    callDialog.id = 'incoming-call';
    callDialog.innerHTML = `
        <div class="call-dialog-content">
            <h3>Incoming ${data.callType} Call</h3>
            <p>${data.fromName} is calling...</p>
            <div class="call-buttons">
                <button onclick="acceptCall()" class="accept-call-btn"><i class="fas fa-phone"></i> Accept</button>
                <button onclick="rejectCall()" class="reject-call-btn"><i class="fas fa-phone-slash"></i> Reject</button>
            </div>
        </div>
    `;
    document.body.appendChild(callDialog);
    
    showNotification(`Incoming ${data.callType} call from ${data.fromName}`, { 
        userId: data.fromUserId, 
        body: 'Tap to answer' 
    });
});

// FIXED: Accept call
window.acceptCall = async function() {
    document.getElementById('incoming-call')?.remove();
    
    if (!pendingCall) {
        showToast('No incoming call', 'error');
        return;
    }
    
    try {
        callType = pendingCall.callType;
        
        const constraints = { 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 2,
                sampleRate: 48000
            }
        };
        
        if (pendingCall.callType === 'video') {
            constraints.video = {
                width: { ideal: 640, min: 320 },
                height: { ideal: 480, min: 240 },
                facingMode: 'user',
                frameRate: { ideal: 20, min: 10 }
            };
        }
        
        showToast('Accepting call...', 'info');
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Local stream obtained for accepting call');
        } catch (err) {
            console.error('Media device error:', err);
            showToast('Failed to access media devices', 'error');
            return;
        }
        
        peerConnection = new RTCPeerConnection({
            iceServers: configuration.iceServers,
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        localStream.getTracks().forEach(track => {
            console.log('Adding track:', track.kind);
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            showCallScreen(pendingCall.callType);
            
            setTimeout(() => {
                if (pendingCall.callType === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = remoteStream;
                        remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                    }
                } else {
                    const audio = new Audio();
                    audio.srcObject = remoteStream;
                    audio.play().catch(e => console.log('Audio play error:', e));
                }
            }, 500);
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', { 
                    toUserId: pendingCall.fromUserId, 
                    candidate: event.candidate,
                    fromUserId: currentUser.userId
                });
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                callStartTime = Date.now();
                startCallTimer();
            } else if (peerConnection.connectionState === 'disconnected' || 
                       peerConnection.connectionState === 'failed') {
                showToast('Call disconnected', 'warning');
                endCall();
            }
        };
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingCall.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('call-answer', { 
            toUserId: pendingCall.fromUserId, 
            answer: answer,
            fromUserId: currentUser.userId
        });
        
        callActive = true;
        
    } catch (error) {
        console.error('Accept call error:', error);
        showToast('Failed to accept call: ' + error.message, 'error');
        endCall();
    }
};

window.rejectCall = function() {
    document.getElementById('incoming-call')?.remove();
    socket.emit('call-end', { 
        toUserId: pendingCall.fromUserId, 
        fromUserId: currentUser.userId 
    });
    pendingCall = null;
};

// FIXED: Call answer handler
socket.on('call-answer', async (data) => {
    console.log('Call answer received');
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            document.getElementById('call-dialog')?.remove();
            console.log('Remote description set successfully');
        } catch (error) {
            console.error('Error setting remote description:', error);
            showToast('Call connection failed', 'error');
            endCall();
        }
    }
});

// FIXED: ICE candidate handler
socket.on('ice-candidate', async (data) => {
    console.log('ICE candidate received');
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log('ICE candidate added');
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
});

socket.on('call-end', () => {
    endCall();
    showToast('Call ended', 'info');
});

socket.on('call-busy', () => {
    endCall();
    showToast('User is busy', 'warning');
});

socket.on('message-queued', () => {
    showToast('Message queued - user is offline', 'info');
});

socket.on('last-seen-update', (data) => {
    const userItem = document.getElementById(`user-${data.userId}`);
    if (userItem && data.userId !== currentUser?.userId) {
        const statusEl = userItem.querySelector('.user-info p');
        statusEl.innerHTML = `<i class="fas fa-circle" style="color:#999;"></i> ${getLastSeenText(data.timestamp)}`;
    }
});

// Click anywhere to close delete menu
document.addEventListener('click', (e) => {
    if (!e.target.closest('.message-delete-btn') && !e.target.closest('.delete-menu')) {
        closeDeleteMenu();
    }
});

// ========== Initialize on load ==========
window.addEventListener('load', async () => {
    await requestNotificationPermission();
    loadMessageQueue();
    
    const uniqueId = await generateUniqueUserId();
    document.getElementById('login-userid').value = uniqueId;
    
    const userData = loadUserData();
    if (userData && userData.userId === uniqueId) {
        document.getElementById('login-name').value = userData.name || '';
        if (userData.profilePic) {
            setTimeout(() => {
                const profilePicDiv = document.getElementById('profile-pic');
                if (profilePicDiv) profilePicDiv.innerHTML = `<img src="${userData.profilePic}" alt="Profile">`;
            }, 1000);
        }
        setTimeout(() => login(), 500);
    }
    
    const blocked = localStorage.getItem('hj-blocked-users');
    if (blocked) blockedUsers = JSON.parse(blocked);
});
