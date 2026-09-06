const socket = io({ transports: ['websocket', 'polling'] });
const videoGrid = document.getElementById('video-grid');
const videoWrapper = document.querySelector('.video-grid-wrapper');
const roomId = location.pathname.split('/').filter(Boolean).pop();

const peers = {};
const peerVideoMap = {};
const peerAudioMap = {};
const peerNames = {};

let currentUserName = '';
let currentUserPhone = '';
let isHost = false;
let cameraStream = null;
let outgoingStream = null;
let activeScreenStream = null;
let myPeer = null;
let myPeerId = null;
let screenSharing = false;
let currentPresenterPeerId = null;
let joined = false;

socket.on('duplicate-kicked', (msg) => {
  alert(msg || 'Duplicate number blocked');
  stopAllTracks();
  location.href = '/';
});
socket.on('join-rejected', (msg) => {
  alert(msg || 'Join rejected');
  location.href = '/';
});

async function verifyAndJoin() {
  const name = document.getElementById('user-name-input').value.trim();
  const phone = document.getElementById('user-phone-input').value.trim();
  const err = document.getElementById('auth-error');
  const btn = document.getElementById('verify-btn');

  if (!name || !phone) {
    err.innerText = 'নাম + নম্বর লাগবে!';
    err.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Checking...';

  try {
    const res = await fetch('/api/verify-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, phone })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      err.innerText = data.message || 'Access Denied';
      err.style.display = 'block';
      btn.disabled = false;
      btn.innerHTML = 'Join Meeting';
      return;
    }

    currentUserName = name;
    currentUserPhone = phone.replace(/[^0-9]/g, '');
    isHost = !!data.isHost;

    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('meeting-stage').style.display = 'flex';
    document.getElementById('room-display').innerText = data.title || 'Meeting';
    if (isHost) document.getElementById('screen-btn').style.display = 'flex';

    startMeeting();
  } catch (e) {
    err.innerText = 'Server error';
    err.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = 'Join Meeting';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const p = document.getElementById('user-phone-input');
  if (p) p.addEventListener('keydown', e => e.key === 'Enter' && verifyAndJoin());
});

async function getMedia() {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); } catch (e) {}
  try { return await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); } catch (e) {}
  try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (e) {}
  return null;
}

function liveVideo(s) {
  return !!(s && s.getVideoTracks().some(t => t.readyState === 'live' && t.enabled));
}
function liveAudio(s) {
  return !!(s && s.getAudioTracks().some(t => t.readyState === 'live'));
}

function makePeer() {
  const secure = location.protocol === 'https:';
  return new Peer(undefined, {
    path: '/peerjs',
    host: location.hostname,
    port: secure ? 443 : Number(location.port || 3000),
    secure,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });
}

function stopAllTracks() {
  try {
    cameraStream?.getTracks?.().forEach(t => t.stop());
    activeScreenStream?.getTracks?.().forEach(t => t.stop());
    myPeer?.destroy?.();
  } catch (e) {}
}

async function startMeeting() {
  if (videoGrid) videoGrid.innerHTML = '';
  joined = false;

  cameraStream = await getMedia();
  outgoingStream = cameraStream;

  myPeer = makePeer();

  myPeer.on('open', (id) => {
    myPeerId = id;
    peerNames[id] = { name: currentUserName, isHost };
    renderOwn();
    if (!joined) {
      joined = true;
      socket.emit('join-room', roomId, id, currentUserName, currentUserPhone, isHost);
    }
  });

  myPeer.on('call', (call) => {
    if (!call?.peer || call.peer === myPeerId) return;
    call.answer(outgoingStream || new MediaStream());
    bindCall(call, call.peer);
  });

  socket.on('existing-users', (list) => {
    (list || []).forEach(u => {
      if (!u.peerId || u.peerId === myPeerId) return;
      peerNames[u.peerId] = { name: u.name, isHost: !!u.isHost };
      callUser(u.peerId);
    });
  });

  socket.on('user-connected', (id, name, host) => {
    if (!id || id === myPeerId) return;
    peerNames[id] = { name, isHost: !!host };
    setTimeout(() => callUser(id), 400);
  });

  socket.on('user-disconnected', (id) => {
    if (id === currentPresenterPeerId) setPresent(null, false);
    closePeer(id);
    delete peerNames[id];
  });

  socket.on('participants-update', (list) => {
    (list || []).forEach(p => {
      if (p.peerId) peerNames[p.peerId] = { name: p.name, isHost: !!p.isHost };
    });
    updatePeople(list || []);
    refreshBadges();
  });

  socket.on('host-screen-sharing', (active, hostName, hostPeerId) => {
    const banner = document.getElementById('screen-share-banner');
    if (active) {
      if (banner) banner.style.display = 'flex';
      const t = document.getElementById('screen-share-text');
      if (t) t.innerText = `${hostName} is presenting`;
      setPresent(hostPeerId, true);
    } else {
      if (banner) banner.style.display = 'none';
      setPresent(null, false);
    }
  });
}

function callUser(id) {
  if (!myPeer || !id || id === myPeerId || peers[id]) return;
  try {
    const call = myPeer.call(id, outgoingStream || new MediaStream());
    if (call) bindCall(call, id);
  } catch (e) {}
}

function closePeer(id) {
  try { peers[id]?.close?.(); } catch (e) {}
  delete peers[id];
  removeCard(id);
  removeAudio(id);
}

function bindCall(call, id) {
  if (!call || !id || id === myPeerId) return;
  try { if (peers[id] && peers[id] !== call) peers[id].close(); } catch (e) {}
  peers[id] = call;

  call.on('stream', (stream) => {
    const info = peerNames[id] || { name: 'Participant', isHost: false };
    const label = info.name + (info.isHost ? ' (Host)' : '');
    if (liveVideo(stream)) {
      showVideo(id, stream, label, false, false);
      removeAudio(id);
    } else {
      showAvatar(id, label);
      if (liveAudio(stream)) playAudio(id, stream);
      else removeAudio(id);
    }
  });

  call.on('close', () => {
    if (peers[id] === call) {
      delete peers[id];
      removeCard(id);
      removeAudio(id);
    }
  });
}

function setPresent(id, on) {
  currentPresenterPeerId = on ? id : null;
  if (!videoWrapper) return;
  videoWrapper.classList.toggle('presenting-mode', !!on);
  document.querySelectorAll('.video-card').forEach(c => {
    c.classList.toggle('presenting-card', on && c.dataset.peerId === id);
  });
}

function ownLabel() {
  return (currentUserName || 'User') + (isHost ? ' (Host)' : ' (You)');
}

function badgeHTML(title) {
  return `<span class="badge-title"><i class="fas fa-user-circle"></i> ${title}</span>
  <button class="btn-card-fullscreen" onclick="toggleCardFullscreen(this)"><i class="fas fa-expand"></i></button>`;
}

function renderOwn() {
  if (!myPeerId) return;
  // remove leftover local cards
  [...(videoGrid?.querySelectorAll('.video-card') || [])].forEach(c => {
    const pid = c.dataset.peerId;
    if (pid && pid !== myPeerId && String(pid).startsWith('local-')) c.remove();
  });

  if (liveVideo(outgoingStream)) showVideo(myPeerId, outgoingStream, ownLabel(), true, screenSharing);
  else showAvatar(myPeerId, ownLabel());
}

function showVideo(id, stream, title, isLocal, isScreen) {
  if (!videoGrid || !id) return;

  let card = videoGrid.querySelector(`[data-peer-id="${CSS.escape(id)}"]`);
  if (card?.classList.contains('placeholder-card')) {
    card.remove();
    card = null;
    delete peerVideoMap[id];
  }

  let video = peerVideoMap[id];
  if (!card) {
    card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.peerId = id;
    video = document.createElement('video');
    video.playsInline = true;
    video.autoplay = true;
    if (isLocal) video.muted = true;
    const badge = document.createElement('div');
    badge.className = 'user-badge';
    card.appendChild(video);
    card.appendChild(badge);
    videoGrid.appendChild(card);
    peerVideoMap[id] = video;
  } else {
    video = peerVideoMap[id] || card.querySelector('video');
    peerVideoMap[id] = video;
  }

  card.classList.toggle('presenting-card', currentPresenterPeerId === id);
  if (video) {
    video.style.transform = (isLocal && !isScreen) ? 'scaleX(-1)' : 'scaleX(1)';
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => {});
  }
  const b = card.querySelector('.user-badge');
  if (b) b.innerHTML = badgeHTML(title);
}

function showAvatar(id, title) {
  if (!videoGrid || !id) return;
  let card = videoGrid.querySelector(`[data-peer-id="${CSS.escape(id)}"]`);
  if (card && !card.classList.contains('placeholder-card')) {
    // has video element - if no live video wanted, replace
    card.remove();
    delete peerVideoMap[id];
    card = null;
  }
  if (card) {
    const b = card.querySelector('.user-badge');
    if (b) b.innerHTML = badgeHTML(title);
    return;
  }
  card = document.createElement('div');
  card.className = 'video-card placeholder-card';
  card.dataset.peerId = id;
  card.innerHTML = `<div class="avatar-placeholder"><i class="fas fa-user"></i></div><div class="user-badge">${badgeHTML(title)}</div>`;
  videoGrid.appendChild(card);
}

function removeCard(id) {
  const card = videoGrid?.querySelector(`[data-peer-id="${CSS.escape(id)}"]`);
  if (card) card.remove();
  if (peerVideoMap[id]) {
    try { peerVideoMap[id].srcObject = null; } catch (e) {}
    delete peerVideoMap[id];
  }
}

function playAudio(id, stream) {
  let a = peerAudioMap[id];
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true;
    a.style.display = 'none';
    document.body.appendChild(a);
    peerAudioMap[id] = a;
  }
  a.srcObject = stream;
  a.play().catch(() => {});
}
function removeAudio(id) {
  if (!peerAudioMap[id]) return;
  try { peerAudioMap[id].srcObject = null; } catch (e) {}
  peerAudioMap[id].remove();
  delete peerAudioMap[id];
}

function refreshBadges() {
  document.querySelectorAll('.video-card').forEach(c => {
    const id = c.dataset.peerId;
    if (!id) return;
    const title = id === myPeerId ? ownLabel() :
      ((peerNames[id]?.name || 'Participant') + (peerNames[id]?.isHost ? ' (Host)' : ''));
    const b = c.querySelector('.user-badge');
    if (b) b.innerHTML = badgeHTML(title);
  });
}

function toggleCardFullscreen(btn) {
  const card = btn.closest('.video-card');
  if (!document.fullscreenElement) {
    (card.requestFullscreen || card.webkitRequestFullscreen)?.call(card);
    btn.innerHTML = '<i class="fas fa-compress"></i>';
  } else {
    document.exitFullscreen?.();
    btn.innerHTML = '<i class="fas fa-expand"></i>';
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.querySelectorAll('.btn-card-fullscreen').forEach(b => b.innerHTML = '<i class="fas fa-expand"></i>');
  }
});

function updatePeople(list) {
  const n = list.length || 1;
  const a = document.getElementById('p-count');
  const b = document.getElementById('people-count-label');
  if (a) a.innerText = n;
  if (b) b.innerText = n;
  const box = document.getElementById('people-list');
  if (!box) return;
  box.innerHTML = '';
  list.forEach(p => {
    const d = document.createElement('div');
    d.className = 'people-item';
    d.innerHTML = `<div class="people-avatar"><i class="fas fa-user"></i></div>
      <div class="people-name">${p.name}${p.isHost ? ' <span class="host-tag">👑 Host</span>' : ''}</div>`;
    box.appendChild(d);
  });
}

function muteUnmute() {
  const t = cameraStream?.getAudioTracks?.()[0];
  if (!t) return alert('মাইক নেই!');
  t.enabled = !t.enabled;
  const btn = document.getElementById('mic-btn');
  btn.classList.toggle('off-state', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
}

function playStopVideo() {
  const t = cameraStream?.getVideoTracks?.()[0];
  if (!t) return alert('ক্যামেরা নেই!');
  t.enabled = !t.enabled;
  const btn = document.getElementById('video-btn');
  btn.classList.toggle('off-state', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
  if (!screenSharing) {
    outgoingStream = cameraStream;
    renderOwn();
  }
}

// ===== SCREEN SHARE (no black after stop) =====
async function shareScreen() {
  if (!isHost) return alert('শুধু Host screen share করতে পারে!');
  if (screenSharing) return stopScreenShare();

  try {
    activeScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });
    const screenTrack = activeScreenStream.getVideoTracks()[0];
    if (!screenTrack) return;

    screenSharing = true;
    updateScreenBtn(true);
    socket.emit('screen-share-started');

    const tracks = [screenTrack];
    const mic = cameraStream?.getAudioTracks?.()[0];
    if (mic) tracks.push(mic);
    outgoingStream = new MediaStream(tracks);

    setPresent(myPeerId, true);
    renderOwn();
    reCallAll(outgoingStream);

    screenTrack.onended = () => stopScreenShare();
  } catch (e) {
    screenSharing = false;
    updateScreenBtn(false);
  }
}

async function stopScreenShare() {
  const was = screenSharing;
  screenSharing = false;
  updateScreenBtn(false);

  if (was) {
    try { socket.emit('screen-share-stopped'); } catch (e) {}
  }

  if (activeScreenStream) {
    activeScreenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    activeScreenStream = null;
  }

  // restore camera OR avatar (never black empty video)
  outgoingStream = cameraStream || null;
  setPresent(null, false);

  // force rebuild own card
  if (myPeerId) removeCard(myPeerId);
  renderOwn();

  reCallAll(outgoingStream || new MediaStream());
}

function updateScreenBtn(on) {
  const btn = document.getElementById('screen-btn');
  if (!btn) return;
  btn.classList.toggle('off-state', on);
  btn.innerHTML = on ? '<i class="fas fa-times"></i>' : '<i class="fas fa-desktop"></i>';
}

function reCallAll(stream) {
  Object.keys(peers).forEach(id => {
    if (id === myPeerId) return;
    try {
      try { peers[id]?.close?.(); } catch (e) {}
      delete peers[id];
      const call = myPeer.call(id, stream || new MediaStream());
      bindCall(call, id);
    } catch (e) {}
  });
}

function leaveMeeting() {
  if (!confirm('Leave meeting?')) return;
  stopAllTracks();
  location.href = '/';
}

function toggleChat() {
  const c = document.getElementById('chat-window');
  const p = document.getElementById('people-window');
  if (p) p.style.display = 'none';
  if (c) c.style.display = c.style.display === 'flex' ? 'none' : 'flex';
}
function togglePeople() {
  const c = document.getElementById('chat-window');
  const p = document.getElementById('people-window');
  if (c) c.style.display = 'none';
  if (p) p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
}
function copyMeetingLink() {
  navigator.clipboard.writeText(location.href);
  alert('Link copied!');
}
function sendMessage() {
  const i = document.getElementById('chat-message-input');
  if (i?.value.trim()) {
    socket.emit('message', i.value.trim());
    i.value = '';
  }
}
function handleChatKey(e) { if (e.key === 'Enter') sendMessage(); }

socket.on('createMessage', (msg, sender) => {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'msg-bubble';
  d.innerHTML = `<div class="msg-sender">${sender}</div><div class="msg-text">${msg}</div>`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
});

let sec = 0;
setInterval(() => {
  sec++;
  const el = document.getElementById('meeting-time');
  if (el) el.innerText = String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}, 1000);
