const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// إعدادات ومتغيرات النظام
const users = {};
const userRooms = {};
const userIPs = {};
const userLastActive = {};
const userProfiles = {};
const roomHistory = {};
const privateMessages = {};
const MESSAGE_MAX_LENGTH = 500; // زيادة الحد الأقصى للرسائل
const USERNAME_MAX_LENGTH = 15; // زيادة الحد الأقصى لاسم المستخدم
const ROOM_NAME_MAX_LENGTH = 20; // زيادة الحد الأقصى لاسم الغرفة
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_HISTORY_MESSAGES = 50; // عدد الرسائل المحفوظة لكل غرفة
const INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 دقيقة بالميلي ثانية
const bannedIPs = new Set();
const roomAdmins = {};

const BANNED_WORDS = ['zaml', '5tk ana', 'mok ana', '9a7ba', 'zab', '5tk', '5tak', 'aliw9', 'w9', '9lawi', 't7awa'];

// دالة مشفرة لتخزين وفحص كلمات ممنوعة
function containsBannedWords(text) {
    const normalizedText = text.toLowerCase();
    return BANNED_WORDS.some(word =>
        normalizedText.includes(word.toLowerCase())
    );
}

// دالة لتحديث وقت النشاط للمستخدم
function updateUserActivity(socketId) {
    userLastActive[socketId] = Date.now();
}

// دالة للتحقق من المستخدمين غير النشطين
function checkInactiveUsers() {
    const currentTime = Date.now();
    Object.keys(userLastActive).forEach(socketId => {
        if (currentTime - userLastActive[socketId] > INACTIVE_TIMEOUT) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                const room = userRooms[socketId];
                const username = users[socketId];

                if (room && username) {
                    io.to(room).emit('message', {
                        user: 'النظام',
                        text: `تم قطع اتصال ${username} بسبب عدم النشاط`
                    });
                }
                socket.disconnect(true);
            }
        }
    });
}

// إنشاء ملف سجل للرسائل
const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

function logMessage(room, username, message, type = 'text') {
    const date = new Date();
    const logFile = path.join(logDirectory, `${room}_${date.toISOString().split('T')[0]}.log`);
    const logEntry = `[${date.toLocaleTimeString('ar-SA')}] [${type}] ${username}: ${message}\n`;

    fs.appendFile(logFile, logEntry, (err) => {
        if (err) console.error('خطأ في حفظ السجل:', err);
    });
}

// فحص المستخدمين غير النشطين كل دقيقة
setInterval(checkInactiveUsers, 60000);

function printUsersInfo() {
    console.clear();
    const currentTime = new Date().toLocaleTimeString('ar-SA');
    console.log('\n=== معلومات المتصلين ===');
    console.log(`الوقت الحالي: ${currentTime}`);
    console.log(`إجمالي عدد المتصلين: ${Object.keys(users).length}`);
    console.log('------------------------');

    const roomUsers = {};
    Object.keys(userRooms).forEach(socketId => {
        const room = userRooms[socketId];
        if (!roomUsers[room]) {
            roomUsers[room] = [];
        }
        const lastActiveTime = new Date(userLastActive[socketId]).toLocaleTimeString('ar-SA');
        roomUsers[room].push({
            username: users[socketId],
            ip: userIPs[socketId],
            lastActive: lastActiveTime,
            isAdmin: roomAdmins[room] && roomAdmins[room].includes(socketId)
        });
    });

    Object.keys(roomUsers).forEach(room => {
        console.log(`\nالغرفة: ${room}`);
        console.log(`عدد المستخدمين: ${roomUsers[room].length}`);
        roomUsers[room].forEach(user => {
            const adminStatus = user.isAdmin ? '(مشرف)' : '';
            console.log(`- ${user.username} ${adminStatus} (IP: ${user.ip}) | آخر نشاط: ${user.lastActive}`);
        });
        console.log('------------------------');
    });
}

// إضافة تاريخ رسائل الغرفة
function addMessageToHistory(room, messageObj) {
    if (!roomHistory[room]) {
        roomHistory[room] = [];
    }

    roomHistory[room].push(messageObj);

    // حفظ عدد محدد من الرسائل فقط
    if (roomHistory[room].length > MAX_HISTORY_MESSAGES) {
        roomHistory[room].shift();
    }
}

io.on('connection', (socket) => {
    const clientIP = socket.handshake.headers['x-forwarded-for'] ||
        socket.handshake.address;
    userIPs[socket.id] = clientIP;
    updateUserActivity(socket.id);

    // التحقق من الـIP المحظورة
    if (bannedIPs.has(clientIP)) {
        socket.emit('message', {
            user: 'النظام',
            text: 'تم حظرك من الدردشة'
        });
        socket.disconnect(true);
        return;
    }

    console.log(`مستخدم جديد متصل - IP: ${clientIP}`);
    printUsersInfo();

    // إرسال قائمة الغرف النشطة
    socket.emit('activeRooms', Object.keys(roomHistory).map(room => ({
        name: room,
        userCount: getUsersInRoom(room).length
    })));

    socket.on('joinRoom', ({ username, room, password }) => {
        if (containsBannedWords(username) || containsBannedWords(room)) {
            socket.emit('message', {
                user: 'النظام',
                text: 'تم حظرك من الدردشة لاستخدام كلمات غير لائقة'
            });
            bannedIPs.add(clientIP);
            socket.disconnect(true);
            return;
        }

        if (username.length > USERNAME_MAX_LENGTH || room.length > ROOM_NAME_MAX_LENGTH) {
            socket.emit('message', {
                user: 'النظام',
                text: `عذراً، تجاوزت الحد المسموح للأحرف`
            });
            return;
        }

        // التحقق من وجود نفس اسم المستخدم في الغرفة
        const existingUser = Object.entries(users).find(([id, name]) =>
            name === username && userRooms[id] === room && id !== socket.id
        );

        if (existingUser) {
            socket.emit('message', {
                user: 'النظام',
                text: 'عذراً، هذا الاسم مستخدم بالفعل في هذه الغرفة'
            });
            return;
        }

        // إنشاء غرفة جديدة إذا لم تكن موجودة وتعيين أول مستخدم كمشرف
        if (!roomHistory[room]) {
            roomHistory[room] = [];
            roomAdmins[room] = [socket.id];
        }

        socket.join(room);
        users[socket.id] = username;
        userRooms[socket.id] = room;
        updateUserActivity(socket.id);

        // إرسال تاريخ الرسائل للمستخدم الجديد
        if (roomHistory[room] && roomHistory[room].length > 0) {
            socket.emit('messageHistory', roomHistory[room]);
        }

        socket.emit('message', {
            user: 'النظام',
            text: `أهلاً بك ${username} في غرفة ${room}`
        });

        if (roomAdmins[room] && roomAdmins[room].includes(socket.id)) {
            socket.emit('message', {
                user: 'النظام',
                text: `أنت الآن مشرف في هذه الغرفة`
            });
        }

        socket.broadcast.to(room).emit('message', {
            user: 'النظام',
            text: `${username} انضم إلى الغرفة`
        });

        const newMessage = {
            user: 'النظام',
            text: `${username} انضم إلى الغرفة`,
            time: new Date().toLocaleTimeString('ar-SA'),
            id: crypto.randomUUID() // إضافة معرف فريد للرسالة
        };
        addMessageToHistory(room, newMessage);
        logMessage(room, 'النظام', `${username} انضم إلى الغرفة`);

        io.to(room).emit('roomUsers', {
            users: getUsersInRoom(room),
            admins: roomAdmins[room] || []
        });

        printUsersInfo();
    });

    socket.on('imageMessage', ({ username, room, image }) => {
        updateUserActivity(socket.id);
        if (!image || !image.startsWith('data:image/')) {
            socket.emit('message', {
                user: 'النظام',
                text: 'نوع الملف غير مدعوم'
            });
            return;
        }

        const base64Size = Buffer.from(image.split(',')[1], 'base64').length;
        if (base64Size > MAX_IMAGE_SIZE) {
            socket.emit('message', {
                user: 'النظام',
                text: 'حجم الصورة كبير جداً'
            });
            return;
        }

        const imageMessage = {
            user: username,
            image: image,
            time: new Date().toLocaleTimeString('ar-SA'),
            id: crypto.randomUUID() // إضافة معرف فريد للرسالة
        };

        io.to(room).emit('imageMessage', imageMessage);
        addMessageToHistory(room, imageMessage);
        logMessage(room, username, 'أرسل صورة', 'image');
    });

    socket.on('chatMessage', (message) => {
        updateUserActivity(socket.id);
        const room = userRooms[socket.id];
        const username = users[socket.id];

        if (!room || !username) return;

        if (message.length > MESSAGE_MAX_LENGTH) {
            socket.emit('message', {
                user: 'النظام',
                text: `عذراً، لا يمكن إرسال رسالة أطول من ${MESSAGE_MAX_LENGTH} حرف`
            });
            return;
        }

        if (containsBannedWords(message)) {
            socket.emit('message', {
                user: 'النظام',
                text: 'تم حظر الرسالة لاحتوائها على كلمات غير لائقة'
            });
            return;
        }

        const newMessage = {
            user: username,
            text: message,
            time: new Date().toLocaleTimeString('ar-SA'),
            id: crypto.randomUUID() // إضافة معرف فريد للرسالة
        };

        io.to(room).emit('message', newMessage);
        addMessageToHistory(room, newMessage);
        logMessage(room, username, message);
    });

    // رسائل خاصة
    socket.on('privateMessage', ({ targetId, message }) => {
        updateUserActivity(socket.id);
        const senderUsername = users[socket.id];
        const receiverUsername = users[targetId];

        if (!senderUsername || !receiverUsername) return;

        if (message.length > MESSAGE_MAX_LENGTH) {
            socket.emit('privateMessageResponse', {
                success: false,
                message: `عذراً، لا يمكن إرسال رسالة أطول من ${MESSAGE_MAX_LENGTH} حرف`
            });
            return;
        }

        if (containsBannedWords(message)) {
            socket.emit('privateMessageResponse', {
                success: false,
                message: 'تم حظر الرسالة لاحتوائها على كلمات غير لائقة'
            });
            return;
        }

        const privateMsg = {
            from: socket.id,
            fromUser: senderUsername,
            to: targetId,
            toUser: receiverUsername,
            text: message,
            time: new Date().toLocaleTimeString('ar-SA'),
            id: crypto.randomUUID() // إضافة معرف فريد للرسالة
        };

        // حفظ الرسائل الخاصة
        const chatId = [socket.id, targetId].sort().join('-');
        if (!privateMessages[chatId]) {
            privateMessages[chatId] = [];
        }
        privateMessages[chatId].push(privateMsg);

        socket.emit('privateMessage', privateMsg);
        io.to(targetId).emit('privateMessage', privateMsg);

        socket.emit('privateMessageResponse', { success: true });
        logMessage('private', senderUsername, `[إلى ${receiverUsername}]: ${message}`, 'private');
    });

    // أوامر المشرف
    socket.on('kickUser', ({ targetId, room }) => {
        updateUserActivity(socket.id);
        if (roomAdmins[room] && roomAdmins[room].includes(socket.id)) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                const targetUsername = users[targetId];
                io.to(room).emit('message', {
                    user: 'النظام',
                    text: `تم طرد ${targetUsername} من الغرفة بواسطة ${users[socket.id]}`
                });
                targetSocket.leave(room);
                delete userRooms[targetId];
                targetSocket.emit('kicked');
            }
        } else {
            socket.emit('message', {
                user: 'النظام',
                text: 'ليس لديك صلاحية لطرد المستخدمين'
            });
        }
    });

    socket.on('banUser', ({ targetId, room }) => {
        updateUserActivity(socket.id);
        if (roomAdmins[room] && roomAdmins[room].includes(socket.id)) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                const targetIP = userIPs[targetId];
                const targetUsername = users[targetId];

                bannedIPs.add(targetIP);
                io.to(room).emit('message', {
                    user: 'النظام',
                    text: `تم حظر ${targetUsername} من الدردشة بواسطة ${users[socket.id]}`
                });
                targetSocket.disconnect(true);
            }
        } else {
            socket.emit('message', {
                user: 'النظام',
                text: 'ليس لديك صلاحية لحظر المستخدمين'
            });
        }
    });

    socket.on('makeAdmin', ({ targetId, room }) => {
        updateUserActivity(socket.id);
        if (roomAdmins[room] && roomAdmins[room].includes(socket.id)) {
            if (!roomAdmins[room].includes(targetId)) {
                roomAdmins[room].push(targetId);
                io.to(room).emit('adminUpdate', {
                    admins: roomAdmins[room]
                });

                io.to(targetId).emit('message', {
                    user: 'النظام',
                    text: `تم تعيينك كمشرف في الغرفة بواسطة ${users[socket.id]}`
                });
            }
        } else {
            socket.emit('message', {
                user: 'النظام',
                text: 'ليس لديك صلاحية لتعيين المشرفين'
            });
        }
    });

    socket.on('typing', ({ username, room }) => {
        updateUserActivity(socket.id);
        socket.broadcast.to(room).emit('userTyping', username);
    });

    socket.on('stopTyping', ({ username, room }) => {
        updateUserActivity(socket.id);
        socket.broadcast.to(room).emit('userStopTyping', username);
    });

    socket.on('updateProfile', (profile) => {
        updateUserActivity(socket.id);
        userProfiles[socket.id] = {
            avatar: profile.avatar,
            status: profile.status,
            bio: profile.bio
        };

        const room = userRooms[socket.id];
        if (room) {
            io.to(room).emit('profileUpdated', {
                userId: socket.id,
                username: users[socket.id],
                profile: userProfiles[socket.id]
            });
        }
    });

    socket.on('deleteMessage', ({ messageId, room }) => {
        updateUserActivity(socket.id);
        const username = users[socket.id];
        if (!username || !room) return;

        // البحث عن الرسالة في تاريخ الغرفة
        if (roomHistory[room]) {
            const messageIndex = roomHistory[room].findIndex(msg => msg.id === messageId && msg.user === username);
            if (messageIndex !== -1) {
                // حذف الرسالة من التاريخ
                roomHistory[room].splice(messageIndex, 1);

                // إعلام جميع المستخدمين في الغرفة بحذف الرسالة
                io.to(room).emit('messageDeleted', { messageId, room });
            }
        }
    });

    socket.on('disconnect', () => {
        const room = userRooms[socket.id];
        const username = users[socket.id];

        if (username && room) {
            const leaveMessage = {
                user: 'النظام',
                text: `${username} غادر الغرفة`,
                time: new Date().toLocaleTimeString('ar-SA'),
                id: crypto.randomUUID() // إضافة معرف فريد للرسالة
            };

            io.to(room).emit('message', leaveMessage);
            addMessageToHistory(room, leaveMessage);
            logMessage(room, 'النظام', `${username} غادر الغرفة`);

            // إزالة المستخدم من قائمة المشرفين إذا كان موجودًا
            if (roomAdmins[room] && roomAdmins[room].includes(socket.id)) {
                roomAdmins[room] = roomAdmins[room].filter(id => id !== socket.id);

                // إذا لم يعد هناك مشرفين، تعيين أول مستخدم متبقي كمشرف
                if (roomAdmins[room].length === 0) {
                    const remainingUsers = getUsersInRoom(room);
                    if (remainingUsers.length > 0) {
                        roomAdmins[room] = [remainingUsers[0].id];
                        io.to(remainingUsers[0].id).emit('message', {
                            user: 'النظام',
                            text: 'تم تعيينك كمشرف في الغرفة'
                        });
                    }
                }

                io.to(room).emit('adminUpdate', {
                    admins: roomAdmins[room]
                });
            }

            delete users[socket.id];
            delete userRooms[socket.id];
            delete userIPs[socket.id];
            delete userLastActive[socket.id];
            delete userProfiles[socket.id];

            io.to(room).emit('roomUsers', {
                users: getUsersInRoom(room),
                admins: roomAdmins[room] || []
            });

            printUsersInfo();
        }
    });
});

function getUsersInRoom(room) {
    const socketsInRoom = io.sockets.adapter.rooms.get(room);
    if (!socketsInRoom) return [];

    return Array.from(socketsInRoom).map(socketId => ({
        username: users[socketId],
        id: socketId,
        profile: userProfiles[socketId] || {}
    }));
}

// إضافة طريقة لعرض الغرف النشطة من خلال API
app.get('/api/rooms', (req, res) => {
    const activeRooms = Object.keys(roomHistory).map(room => ({
        name: room,
        userCount: getUsersInRoom(room).length,
        createdAt: roomHistory[room].length > 0 ? roomHistory[room][0].time : 'غير معروف'
    }));

    res.json(activeRooms);
});

const PORT = process.env.PORT || 1800;
server.listen(PORT, () => {
    console.log(`\n=== معلومات الخادم ===`);
    console.log(`تم تشغيل الخادم على المنفذ: ${PORT}`);
    console.log(`الوقت: ${new Date().toLocaleTimeString('ar-SA')}`);
    console.log('انتظار اتصال المستخدمين...\n');
});