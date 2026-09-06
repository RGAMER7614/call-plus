const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
const { ExpressPeerServer } = require('peer');
const { v4: uuidV4 } = require('uuid');
const path = require('path');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const peerServer = ExpressPeerServer(server, {
  debug: false,
  allow_discovery: true
});
app.use('/peerjs', peerServer);
app.use(express.static('public'));

const meetingsDB = {};
const activeRoomUsers = {};   // roomId -> { phone: socketId }
const roomParticipants = {};  // roomId -> [{ socketId, peerId, name, phone, isHost }]
const adminsDB = { admin: '1234' };

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin-signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username/Password লাগবে!' });
  if (adminsDB[username]) return res.json({ success: false, message: 'Username আগে থেকেই আছে!' });
  adminsDB[username] = password;
  res.json({ success: true, message: 'Signup Successful!' });
});

app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (adminsDB[username] && adminsDB[username] === password) return res.json({ success: true });
  res.json({ success: false, message: 'ভুল Username/Password!' });
});

app.post('/api/create-meeting', (req, res) => {
  const { title, numbers, hostPhone } = req.body;
  if (!numbers || !numbers.trim()) return res.json({ success: false, message: 'কমপক্ষে ১টা নম্বর লাগবে!' });

  const roomId = uuidV4();
  const allowedNumbers = numbers
    .split(/[\n,]+/)
    .map(n => n.trim().replace(/[^0-9]/g, ''))
    .filter(n => n.length >= 10);

  // unique numbers only
  const uniqueNumbers = [...new Set(allowedNumbers)];
  const cleanHost = (hostPhone || '').trim().replace(/[^0-9]/g, '');

  if (cleanHost && !uniqueNumbers.includes(cleanHost)) uniqueNumbers.push(cleanHost);
  if (uniqueNumbers.length === 0) return res.json({ success: false, message: 'বৈধ নম্বর পাওয়া যায়নি!' });

  meetingsDB[roomId] = {
    title: title || 'Private Meeting',
    allowedNumbers: uniqueNumbers,
    hostPhone: cleanHost || uniqueNumbers[0],
    createdAt: new Date()
  };

  res.json({
    success: true,
    roomId,
    meetingUrl: `${req.protocol}://${req.get('host')}/${roomId}`,
    hostPhone: meetingsDB[roomId].hostPhone
  });
});

// Verify + check if number already in meeting
app.post('/api/verify-user', (req, res) => {
  const { roomId, phone } = req.body;
  const cleanPhone = (phone || '').trim().replace(/[^0-9]/g, '');
  const meeting = meetingsDB[roomId];

  if (!meeting) {
    return res.status(403).json({
      success: false,
      message: 'মিটিং পাওয়া যায়নি! Admin কে নতুন লিংক তৈরি করতে বলুন।'
    });
  }

  if (!meeting.allowedNumbers.includes(cleanPhone)) {
    return res.status(403).json({
      success: false,
      message: 'Access Denied! আপনার নম্বরটি অনুমোদিত নয়।'
    });
  }

  // 🔒 already joined with this number?
  if (activeRoomUsers[roomId] && activeRoomUsers[roomId][cleanPhone]) {
    return res.status(403).json({
      success: false,
      message: 'এই নম্বর দিয়ে ইতিমধ্যে কেউ মিটিংয়ে আছে! এক নম্বরে একজনই ঢুকতে পারবে।'
    });
  }

  res.json({
    success: true,
    title: meeting.title,
    isHost: meeting.hostPhone === cleanPhone
  });
});

app.get('/:room', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

io.on('connection', (socket) => {
  console.log('🟢 Socket connected:', socket.id);

  socket.on('join-room', (roomId, userId, userName, userPhone, isHost) => {
    const cleanPhone = (userPhone || '').trim().replace(/[^0-9]/g, '');

    if (!roomId || !userId || !cleanPhone) {
      socket.emit('join-rejected', 'Invalid join data');
      return;
    }

    if (!activeRoomUsers[roomId]) activeRoomUsers[roomId] = {};
    if (!roomParticipants[roomId]) roomParticipants[roomId] = [];

    // 🔒 ONE NUMBER = ONE PERSON (socket level)
    if (activeRoomUsers[roomId][cleanPhone]) {
      const oldSocketId = activeRoomUsers[roomId][cleanPhone];

      // kick OLD user
      io.to(oldSocketId).emit('duplicate-kicked',
        '🚨 আপনার নম্বর দিয়ে অন্য ডিভাইস থেকে ঢোকার চেষ্টা হয়েছে। সিকিউরিটির জন্য আপনাকে বের করা হলো।'
      );

      // reject NEW user too
      socket.emit('duplicate-kicked',
        '🚨 এই নম্বর দিয়ে ইতিমধ্যে সেশন ছিল। এক নম্বরে একজনই থাকতে পারবে। আবার চেষ্টা করুন।'
      );

      // cleanup old
      delete activeRoomUsers[roomId][cleanPhone];
      roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.phone !== cleanPhone);
      io.to(roomId).emit('participants-update', roomParticipants[roomId]);

      // also remove old from room if still connected
      const oldSock = io.sockets.sockets.get(oldSocketId);
      if (oldSock) {
        oldSock.leave(roomId);
      }
      return;
    }

    // register
    activeRoomUsers[roomId][cleanPhone] = socket.id;
    socket.roomId = roomId;
    socket.userPhone = cleanPhone;
    socket.peerId = userId;
    socket.userName = userName;

    // existing users BEFORE adding me (for new joiner to call)
    const existing = roomParticipants[roomId]
      .filter(p => p.peerId && p.peerId !== userId)
      .map(p => ({
        peerId: p.peerId,
        name: p.name,
        isHost: !!p.isHost
      }));

    roomParticipants[roomId].push({
      socketId: socket.id,
      peerId: userId,
      name: userName,
      phone: cleanPhone,
      isHost: !!isHost
    });

    socket.join(roomId);

    // 1) tell ME who is already here → I will call them
    socket.emit('existing-users', existing);

    // 2) tell OTHERS that I joined → they will call me
    socket.to(roomId).emit('user-connected', userId, userName, !!isHost);

    // 3) everyone gets people list
    io.to(roomId).emit('participants-update', roomParticipants[roomId]);

    console.log(`👤 ${userName} (${cleanPhone}) joined ${roomId} | peers now: ${roomParticipants[roomId].length}`);

    socket.on('message', (message) => {
      io.to(roomId).emit('createMessage', message, userName);
    });

    socket.on('screen-share-started', () => {
      socket.to(roomId).emit('host-screen-sharing', true, userName, userId);
    });

    socket.on('screen-share-stopped', () => {
      socket.to(roomId).emit('host-screen-sharing', false, userName, userId);
    });

    socket.on('disconnect', () => {
      if (socket.roomId && socket.userPhone && activeRoomUsers[socket.roomId]) {
        // only delete if this socket still owns the phone slot
        if (activeRoomUsers[socket.roomId][socket.userPhone] === socket.id) {
          delete activeRoomUsers[socket.roomId][socket.userPhone];
        }
      }
      if (roomParticipants[roomId]) {
        roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.socketId !== socket.id);
        io.to(roomId).emit('participants-update', roomParticipants[roomId]);
      }
      socket.to(roomId).emit('user-disconnected', userId);
      console.log(`🔴 ${userName} left ${roomId}`);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Default Admin: admin / 1234`);
});
