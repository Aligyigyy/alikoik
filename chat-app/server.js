const express = require('express');
const app = express();
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// إعداد الخادم
const PORT = 3000;
const server = http.createServer(app);
const io = new Server(server);

let rooms = {}; // لتتبع الغرف والمستخدمين فيها

// تقديم الملفات الثابتة
app.use(express.static(path.join(__dirname, 'public')));

// المسار الافتراضي
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// التعامل مع اتصالات WebSocket
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // انضمام المستخدم إلى غرفة
  socket.on('joinRoom', (room) => {
    socket.join(room);

    // إضافة المستخدم إلى قائمة الغرف
    if (!rooms[room]) rooms[room] = [];
    rooms[room].push(socket.id);

    // إعلام الجميع في الغرفة
    io.to(room).emit('message', `🔵 User ${socket.id} joined room: ${room}`);
    io.emit('updateRooms', rooms); // تحديث قائمة الغرف للجميع
    console.log(`User ${socket.id} joined room ${room}`);
  });

  // استقبال الرسائل وإرسالها إلى الغرفة
  socket.on('chatMessage', ({ room, message }) => {
    io.to(room).emit('message', `💬 ${socket.id}: ${message}`);
  });

  // عند انقطاع اتصال المستخدم
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    // إزالة المستخدم من الغرف
    for (let room in rooms) {
      rooms[room] = rooms[room].filter((id) => id !== socket.id);
      if (rooms[room].length === 0) delete rooms[room]; // حذف الغرفة إذا أصبحت فارغة
    }

    io.emit('updateRooms', rooms); // تحديث قائمة الغرف للجميع
  });
});

// بدء تشغيل الخادم
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
