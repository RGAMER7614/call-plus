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

const peerServer = ExpressPeerServer(server, { debug: false, allow_discovery: true });
app.use('/peerjs', peerServer);
app.use(express.static('public'));

const meetingsDB = {};
const activeRoomUsers = {};   // roomId -> { phone: { socketId, peerId } }
const roomParticipants = {};
const adminsDB = { admin: '1234' };

function cleanPhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin-signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Username/Password লাগবে!' });
  if (adminsDB[username]) return res.json({ success: false, message: 'Username আগে থেকেই আছে!' });
  adminsDB[username] = password;
  res.json({ success: true });
});

app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (adminsDB[username] && adminsDB[username] === password) return res.json({ success: true });
  res.json({ success: false, message: 'ভুল Username/Password!' });
});

app.post('/api/create-meeting', (req, res) => {
  const { title, numbers, hostPhone } = req.body;
  if (!numbers || !String(numbers).trim()) {
    return res.json({ success: false, message: 'কমপক্ষে ১টা নম্বর লাগবে!' });
  }

  const roomId = uuidV4();
  let allowed = String(numbers)
    .split(/[\n,]+/)
    .map(cleanPhone)
    .filter(n => n.length >= 10);

  allowed = [...new Set(allowed)];
  const host = cleanPhone(hostPhone);
  if (host && !allowed.includes(host)) allowed.push(host);

  if (!allowed.length) return res.json({ success: false, message: 'বৈধ নম্বর নেই!' });

  meetingsDB[roomId] = {
    title: title || 'Private Meeting',
    allowedNumbers: allowed,
    hostPhone: host || allowed[0]
  };

  // reset room trackers
  activeRoomUsers[roomId] = {};
  roomParticipants[roomId] = [];

  res.json({
    success: true,
    roomId,
    meetingUrl: `${req.protocol}://${req.get('host')}/${roomId}`,
    hostPhone: meetingsDB[roomId].hostPhone
  });
});

// HARD BLOCK same number before enter
app.post('/api/verify-user', (req, res) => {
  const roomId = req.body.roomId;
  const phone = cleanPhone(req.body.phone);
  const meeting = meetingsDB[roomId];

  if (!meeting) {
    return res.status(403).json({ success: false, message: 'মিটিং নেই! Admin নতুন লিংক বানাও।' });
  }
  if (!meeting.allowedNumbers.includes(phone)) {
    return res.status(403).json({ success: false, message: 'Access Denied! নম্বর অনুমোদিত নয়।' });
  }

  // if number already active in this room => BLOCK
  const active = activeRoomUsers[roomId] && activeRoomUsers[roomId][phone];
  if (active && active.socketId) {
    const stillOnline = io.sockets.sockets.get(active.socketId);
    if (stillOnline) {
      return res.status(403).json({
        success: false,
        message: '⛔ এই নম্বর দিয়ে ইতিমধ্যে কেউ মিটিংয়ে আছে। এক নম্বরে একজনই ঢুকতে পারবে।'
      });
    }
    // stale entry cleanup
    delete activeRoomUsers[roomId][phone];
  }

  res.json({
    success: true,
    title: meeting.title,
    isHost: meeting.hostPhone === phone
  });
});

app.get('/:room', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, userId, userName, userPhone, isHost) => {
    const phone = cleanPhone(userPhone);
    if (!roomId || !userId || !phone) {
      socket.emit('join-rejected', 'Invalid data');
      return;
    }

    if (!activeRoomUsers[roomId]) activeRoomUsers[roomId] = {};
    if (!roomParticipants[roomId]) roomParticipants[roomId] = [];

    // SECOND hard check on socket join
    const existing = activeRoomUsers[roomId][phone];
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      const old = io.sockets.sockets.get(existing.socketId);
      if (old) {
        // keep first user, reject second
        socket.emit('duplicate-kicked', '⛔ এই নম্বর ইতিমধ্যে ব্যবহৃত হচ্ছে। অন্য নম্বর দিন।');
        return;
      }
      // old gone -> free slot
      delete activeRoomUsers[roomId][phone];
      roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.phone !== phone);
    }

    // register this phone exclusively
    activeRoomUsers[roomId][phone] = { socketId: socket.id, peerId: userId };

    socket.roomId = roomId;
    socket.userPhone = phone;
    socket.peerId = userId;
    socket.userName = userName || 'User';

    const existingUsers = roomParticipants[roomId]
      .filter(p => p.peerId && p.peerId !== userId)
      .map(p => ({ peerId: p.peerId, name: p.name, isHost: !!p.isHost }));

    // avoid duplicate participant rows
    roomParticipants[roomId] = roomParticipants[roomId].filter(p => p.phone !== phone && p.peerId !== userId);
    roomParticipants[roomId].push({
      socketId: socket.id,
      peerId: userId,
      name: socket.userName,
      phone,
      isHost: !!isHost
    });

    socket.join(roomId);

    socket.emit('existing-users', existingUsers);
    socket.to(roomId).emit('user-connected', userId, socket.userName, !!isHost);
    io.to(roomId).emit('participants-update', roomParticipants[roomId]);

    socket.on('message', (msg) => {
      io.to(roomId).emit('createMessage', msg, socket.userName);
    });

    socket.on('screen-share-started', () => {
      socket.to(roomId).emit('host-screen-sharing', true, socket.userName, userId);
    });
    socket.on('screen-share-stopped', () => {
      socket.to(roomId).emit('host-screen-sharing', false, socket.userName, userId);
    });

    socket.on('disconnect', () => {
      if (socket.roomId && socket.userPhone && activeRoomUsers[socket.roomId]) {
        const slot = activeRoomUsers[socket.roomId][socket.userPhone];
        if (slot && slot.socketId === socket.id) {
          delete activeRoomUsers[socket.roomId][socket.userPhone];
        }
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
  console.log(`🚀 Server on ${PORT}`);
  console.log('🔑 admin / 1234');
});
