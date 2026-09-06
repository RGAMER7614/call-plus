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

// PeerJS Server
const peerServer = ExpressPeerServer(server, {
  debug: false,
  allow_discovery: true
});
app.use('/peerjs', peerServer);
app.use(express.static('public'));

// Databases (in-memory)
const meetingsDB = {};
const activeRoomUsers = {};
const roomParticipants = {};
const adminsDB = { admin: '1234' };

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// API: Admin Auth
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

// API: Create Meeting
app.post('/api/create-meeting', (req, res) => {
  const { title, numbers, hostPhone } = req.body;
  if (!numbers || !numbers.trim()) return res.json({ success: false, message: 'কমপক্ষে ১টা নম্বর লাগবে!' });

  const roomId = uuidV4();
  const allowedNumbers = numbers
    .split(/[\n,]+/)
    .map(n => n.trim().replace(/[^0-9]/g, ''))
    .filter(n => n.length >= 10);
  const cleanHost = (hostPhone || '').trim().replace(/[^0-9]/g, '');

  if (cleanHost && !allowedNumbers.includes(cleanHost)) allowedNumbers.push(cleanHost);
  if (allowedNumbers.length === 0) return res.json({ success: false, message: 'বৈধ নম্বর পাওয়া যায়নি!' });

  meetingsDB[roomId] = {
    title: title || 'Private Meeting',
    allowedNumbers,
    hostPhone: cleanHost || allowedNumbers[0],
    createdAt: new Date()
  };

  res.json({
    success: true,
    roomId,
    meetingUrl: `${req.protocol}://${req.get('host')}/${roomId}`,
    hostPhone: meetingsDB[roomId].hostPhone
  });
});

// API: Verify User
app.post('/api/verify-user', (req, res) => {
  const { roomId, phone } = req.body;
  const cleanPhone = (phone || '').trim().replace(/[^0-9]/g, '');
  const meeting = meetingsDB[roomId];

  if (!meeting) return res.status(403).json({ success: false, message: 'মিটিং পাওয়া যায়নি! Admin কে নতুন লিংক তৈরি করতে বলুন।' });
  if (!meeting.allowedNumbers.includes(cleanPhone)) return res.status(403).json({ success: false, message: 'Access Denied! আপনার নম্বরটি অনুমোদিত নয়।' });

  res.json({ success: true, title: meeting.title, isHost: meeting.hostPhone === cleanPhone });
});

app.get('/:room', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

// Socket.IO
io.on('connection', (socket) => {
  console.log('🟢 Socket connected:', socket.id);

  socket.on('join-room', (roomId, userId, userName, userPhone, isHost) => {
    const cleanPhone = (userPhone || '').trim().replace(/[^0-9]/g, '');
    if (!activeRoomUsers[roomId]) activeRoomUsers[roomId] = {};
    if (!roomParticipants[roomId]) roomParticipants[roomId] = [];

    // Duplicate kick
    if (activeRoomUsers[roomId][cleanPhone]) {
      const firstId = activeRoomUsers[roomId][cleanPhone];
      io.to(firstId).emit('duplicate-kicked', '🚨 একই নম্বর দিয়ে অন্য কেউ ঢুকতে চাওয়ায় দুজনকেই বের করা হলো!');
      socket.emit('duplicate-kicked', '🚨 এই নম্বরে ইতিমধ্যে কেউ আছে! দুজনকেই বের করা হলো।');
      delete activeRoomUsers[roomId][cleanPhone];
      roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.phone !== cleanPhone);
      io.to(roomId).emit('participants-update', roomParticipants[roomId]);
      return;
    }

    activeRoomUsers[roomId][cleanPhone] = socket.id;
    socket.roomId = roomId;
    socket.userPhone = cleanPhone;
    socket.peerId = userId;

    roomParticipants[roomId].push({
      socketId: socket.id,
      peerId: userId,
      name: userName,
      phone: cleanPhone,
      isHost
    });

    socket.join(roomId);
    socket.to(roomId).emit('user-connected', userId, userName, isHost);
    io.to(roomId).emit('participants-update', roomParticipants[roomId]);

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
        delete activeRoomUsers[socket.roomId][socket.userPhone];
      }
      if (roomParticipants[roomId]) {
        roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.socketId !== socket.id);
        io.to(roomId).emit('participants-update', roomParticipants[roomId]);
      }
      socket.to(roomId).emit('user-disconnected', userId);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Default Admin: admin / 1234`);
});
