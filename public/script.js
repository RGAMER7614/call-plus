const socket = io({
  transports: ['websocket', 'polling']
});

const videoGrid = document.getElementById('video-grid');
const videoWrapper = document.querySelector('.video-grid-wrapper');
const roomId = window.location.pathname.split('/').pop();

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
let hasJoinedRoom = false; // prevent double join

socket.on('duplicate-kicked', (reason) => {
  alert(reason);
  location.href = '/';
});

// ============================================
// VERIFY
// ============================================
async function verifyAndJoin() {
  const nameInput = document.getElementById('user-name-input').value.trim();
  const phoneInput = document.getElementById('user-phone-input').value.trim();
  const errorBadge = document.getElementById('auth-error');
  const verifyBtn = document.getElementById('verify-btn');

  if (!nameInput || !phoneInput) {
    errorBadge.innerText = 'নাম + মোবাইল নম্বর লাগবে!';
    errorBadge.style.display = 'block';
    return;
  }

  verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
  verifyBtn.disabled = true;

  try {
    const res = await fetch('/api/verify-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, phone: phoneInput })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentUserName = nameInput;
      currentUserPhone = phoneInput;
      isHost = !!data.isHost;

      document.getElementById('auth-modal').style.display = 'none';
      document.getElementById('meeting-stage').style.display = 'flex';
      document.getElementById('room-display').innerText = data.title || 'Meeting';

      if (isHost) {
        const sb = document.getElementById('screen-btn');
        if (sb) sb.style.display = 'flex';
      }

      startMeetingStream();
    } else {
      errorBadge.innerText = data.message || 'Access Denied!';
      errorBadge.style.display = 'block';
      verifyBtn.innerHTML = 'Join Meeting';
      verifyBtn.disabled = false;
    }
  } catch (e) {
    console.error(e);
    errorBadge.innerText = 'Server connect হয়নি!';
    errorBadge.style.display = 'block';
    verifyBtn.innerHTML = 'Join Meeting';
    verifyBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const phoneInput = document.getElementById('user-phone-input');
  if (phoneInput) {
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyAndJoin();
    });
  }
});

// ============================================
// MEDIA
// ============================================
async function getMediaStreamWithFallback() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); } catch (e) {}
  try { return await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); } catch (e) {}
  try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (e) {}
  return null;
}

function hasLiveVideo(stream) {
  return !!(stream && stream.getVideoTracks().some(t => t.readyState === 'live'));
}
function hasLiveAudio(stream) {
  return !!(stream && stream.getAudioTracks().some(t => t.readyState === 'live'));
}

function createPeer() {
  const isSecure = location.protocol === 'https:';
  const port = isSecure ? 443 : (location.port ? Number(location.port) : 3000);

  return new Peer(undefined, {
    path: '/peerjs',
    host: location.hostname,
    port: port,
    secure: isSecure,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    },
    debug: 1
  });
}

// ============================================
// START (NO DOUBLE CARD)
// ============================================
async function startMeetingStream() {
  // clear grid once
  if (videoGrid) videoGrid.innerHTML = '';

  cameraStream = await getMediaStreamWithFallback();
  outgoingStream = cameraStream;

  myPeer = createPeer();

  myPeer.on('open', (id) => {
    console.log('✅ Peer open:', id);

    // remove any temp card
    if (myPeerId && myPeerId !== id) {
      removeVideoByPeer(myPeerId);
      delete peerNames[myPeerId];
    }

    myPeerId = id;
    peerNames[myPeerId] = { name: currentUserName, isHost };

    // ONLY ONE own card
    renderOwnCard();

    // join room only once
    if (!hasJoinedRoom) {
      hasJoinedRoom = true;
      socket.emit('join-room', roomId, id, currentUserName, currentUserPhone, isHost);
    }
  });

  myPeer.on('error', (err) => {
    console.error('Peer error:', err);
  });

  // answer calls from others
  myPeer.on('call', (call) => {
    console.log('📞 Incoming call from', call.peer);
    call.answer(outgoingStream || new MediaStream());
    bindCallEvents(call, call.peer);
  });

  // when someone else joins -> call them once
  socket.on('user-connected', (userId, userName, userIsHost) => {
    if (!userId || userId === myPeerId) return;
    if (peers[userId]) return; // already connected

    peerNames[userId] = { name: userName, isHost: !!userIsHost };
    console.log('👤 User connected:', userName, userId);

    setTimeout(() => {
      if (!myPeer || !myPeerId) return;
      if (peers[userId]) return;
      try {
        const call = myPeer.call(userId, outgoingStream || new MediaStream());
        bindCallEvents(call, userId);
      } catch (e) {
        console.warn('call failed', e);
      }
    }, 800);
  });

  socket.on('user-disconnected', (userId) => {
    if (userId === currentPresenterPeerId) setPresentationStageMode(null, false);
    closePeer(userId);
    delete peerNames[userId];
  });

  socket.on('participants-update', (list) => {
    (list || []).forEach(p => {
      if (p.peerId) peerNames[p.peerId] = { name: p.name, isHost: !!p.isHost };
    });
    updateParticipantsUI(list || []);
    refreshAllBadges();
  });

  socket.on('host-screen-sharing', (active, hostName, hostPeerId) => {
    const banner = document.getElementById('screen-share-banner');
    if (active) {
      if (banner) banner.style.display = 'flex';
      const t = document.getElementById('screen-share-text');
      if (t) t.innerText = `${hostName} is presenting`;
      setPresentationStageMode(hostPeerId, true);
    } else {
      if (banner) banner.style.display = 'none';
      setPresentationStageMode(null, false);
    }
  });
}

function closePeer(peerId) {
  if (peers[peerId]) {
    try { peers[peerId].close(); } catch (e) {}
    delete peers[peerId];
  }
  removeVideoByPeer(peerId);
  removeAudioByPeer(peerId);
}

function bindCallEvents(call, peerId) {
  if (!call || !peerId) return;
  if (peerId === myPeerId) return; // never show self as remote

  if (peers[peerId] && peers[peerId] !== call) {
    try { peers[peerId].close(); } catch (e) {}
  }
  peers[peerId] = call;

  call.on('stream', (remoteStream) => {
    if (peerId === myPeerId) return;

    const info = peerNames[peerId] || { name: 'Participant', isHost: false };
    const label = info.name + (info.isHost ? ' (Host)' : '');

    if (hasLiveVideo(remoteStream)) {
      upsertVideoCard(peerId, remoteStream, label, false, false);
      removeAudioByPeer(peerId);
    } else {
      // no camera -> avatar + audio
      upsertPlaceholder(peerId, label);
      if (hasLiveAudio(remoteStream)) playHiddenAudio(peerId, remoteStream);
      else removeAudioByPeer(peerId);
    }
  });

  call.on('close', () => {
    if (peers[peerId] === call) {
      delete peers[peerId];
      removeVideoByPeer(peerId);
      removeAudioByPeer(peerId);
    }
  });
}

function setPresentationStageMode(presenterPeerId, isPresenting) {
  currentPresenterPeerId = isPresenting ? presenterPeerId : null;
  if (!videoWrapper) return;

  if (isPresenting) videoWrapper.classList.add('presenting-mode');
  else videoWrapper.classList.remove('presenting-mode');

  document.querySelectorAll('.video-card').forEach(card => {
    const pid = card.dataset.peerId;
    if (isPresenting && pid === presenterPeerId) card.classList.add('presenting-card');
    else card.classList.remove('presenting-card');
  });
}

// ============================================
// CARDS — only ONE card per peerId
// ============================================
function ownLabel() {
  return (currentUserName || 'User') + (isHost ? ' (Host)' : ' (You)');
}

function getBadgeHTML(title) {
  return `
    <span class="badge-title"><i class="fas fa-user-circle"></i> ${title}</span>
    <button class="btn-card-fullscreen" onclick="toggleCardFullscreen(this)" title="Full Screen">
      <i class="fas fa-expand"></i>
    </button>
  `;
}

function renderOwnCard() {
  if (!myPeerId) return;

  // remove ALL own duplicates first
  cleanupDuplicateOwnCards();

  if (hasLiveVideo(outgoingStream)) {
    upsertVideoCard(myPeerId, outgoingStream, ownLabel(), true, screenSharing);
  } else {
    upsertPlaceholder(myPeerId, ownLabel());
  }
}

function cleanupDuplicateOwnCards() {
  if (!videoGrid || !myPeerId) return;
  const cards = [...videoGrid.querySelectorAll('.video-card')];
  let foundOwn = false;

  cards.forEach(card => {
    const pid = card.dataset.peerId;
    const badge = card.querySelector('.badge-title, .user-badge');
    const text = badge ? badge.innerText : '';

    // remove temp ids
    if (pid && (pid.startsWith('local-') || pid === 'local-temp') && pid !== myPeerId) {
      card.remove();
      delete peerVideoMap[pid];
      return;
    }

    // keep only one card for myPeerId
    if (pid === myPeerId) {
      if (foundOwn) {
        card.remove();
        return;
      }
      foundOwn = true;
    }

    // if badge says (You) but wrong peer id, remove
    if (text.includes('(You)') && pid !== myPeerId) {
      card.remove();
      if (pid) delete peerVideoMap[pid];
    }
  });
}

function upsertVideoCard(peerId, stream, title, isLocal, isScreenShare) {
  if (!videoGrid || !peerId) return;

  // if placeholder exists for same id, replace
  const old = videoGrid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (old && old.classList.contains('placeholder-card')) {
    old.remove();
    delete peerVideoMap[peerId];
  }

  let card = videoGrid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  let video = peerVideoMap[peerId];

  if (!card) {
    card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.peerId = peerId;

    video = document.createElement('video');
    video.playsInline = true;
    video.autoplay = true;
    if (isLocal) video.muted = true;

    const badge = document.createElement('div');
    badge.className = 'user-badge';

    card.appendChild(video);
    card.appendChild(badge);
    videoGrid.appendChild(card);
    peerVideoMap[peerId] = video;
  } else {
    video = peerVideoMap[peerId] || card.querySelector('video');
    peerVideoMap[peerId] = video;
  }

  if (currentPresenterPeerId && peerId === currentPresenterPeerId) {
    card.classList.add('presenting-card');
  } else {
    card.classList.remove('presenting-card');
  }

  if (isLocal && !isScreenShare) video.style.transform = 'scaleX(-1)';
  else video.style.transform = 'scaleX(1)';

  if (video && video.srcObject !== stream) video.srcObject = stream;
  if (video) video.play().catch(() => {});

  const badge = card.querySelector('.user-badge');
  if (badge) badge.innerHTML = getBadgeHTML(title);
}

function upsertPlaceholder(peerId, title) {
  if (!videoGrid || !peerId) return;

  // if video card already exists for this peer, don't add placeholder
  const existing = videoGrid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (existing && !existing.classList.contains('placeholder-card')) {
    // already has video — just update badge
    const badge = existing.querySelector('.user-badge');
    if (badge) badge.innerHTML = getBadgeHTML(title);
    return;
  }

  if (existing && existing.classList.contains('placeholder-card')) {
    const badge = existing.querySelector('.user-badge');
    if (badge) badge.innerHTML = getBadgeHTML(title);
    return;
  }

  const card = document.createElement('div');
  card.className = 'video-card placeholder-card';
  card.dataset.peerId = peerId;
  card.innerHTML = `
    <div class="avatar-placeholder"><i class="fas fa-user"></i></div>
    <div class="user-badge">${getBadgeHTML(title)}</div>
  `;
  videoGrid.appendChild(card);
}

function removeVideoByPeer(peerId) {
  if (!videoGrid || !peerId) return;
  const card = videoGrid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (card) card.remove();
  if (peerVideoMap[peerId]) {
    try { peerVideoMap[peerId].srcObject = null; } catch (e) {}
    delete peerVideoMap[peerId];
  }
}

function playHiddenAudio(peerId, stream) {
  let audio = peerAudioMap[peerId];
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    peerAudioMap[peerId] = audio;
  }
  audio.srcObject = stream;
  audio.play().catch(() => {});
}

function removeAudioByPeer(peerId) {
  if (peerAudioMap[peerId]) {
    try { peerAudioMap[peerId].srcObject = null; } catch (e) {}
    peerAudioMap[peerId].remove();
    delete peerAudioMap[peerId];
  }
}

function refreshAllBadges() {
  document.querySelectorAll('.video-card').forEach(card => {
    const pid = card.dataset.peerId;
    if (!pid) return;
    let title = '';
    if (pid === myPeerId) title = ownLabel();
    else {
      const info = peerNames[pid] || { name: 'Participant', isHost: false };
      title = info.name + (info.isHost ? ' (Host)' : '');
    }
    const badge = card.querySelector('.user-badge');
    if (badge) badge.innerHTML = getBadgeHTML(title);
  });
}

function toggleCardFullscreen(btn) {
  const card = btn.closest('.video-card');
  if (!document.fullscreenElement) {
    if (card.requestFullscreen) card.requestFullscreen();
    else if (card.webkitRequestFullscreen) card.webkitRequestFullscreen();
    btn.innerHTML = '<i class="fas fa-compress"></i>';
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    btn.innerHTML = '<i class="fas fa-expand"></i>';
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.querySelectorAll('.btn-card-fullscreen').forEach(btn => {
      btn.innerHTML = '<i class="fas fa-expand"></i>';
    });
  }
});

function updateParticipantsUI(list) {
  const count = list.length || 1;
  const pc = document.getElementById('p-count');
  const pl = document.getElementById('people-count-label');
  if (pc) pc.innerText = count;
  if (pl) pl.innerText = count;

  const box = document.getElementById('people-list');
  if (!box) return;
  box.innerHTML = '';
  list.forEach(p => {
    const div = document.createElement('div');
    div.className = 'people-item';
    div.innerHTML = `
      <div class="people-avatar"><i class="fas fa-user"></i></div>
      <div class="people-name">${p.name}${p.isHost ? ' <span class="host-tag">👑 Host</span>' : ''}</div>
    `;
    box.appendChild(div);
  });
}

// ============================================
// CONTROLS
// ============================================
function muteUnmute() {
  if (!cameraStream || !cameraStream.getAudioTracks()[0]) return alert('মাইক নেই!');
  const t = cameraStream.getAudioTracks()[0];
  t.enabled = !t.enabled;
  const btn = document.getElementById('mic-btn');
  btn.classList.toggle('off-state', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
}

function playStopVideo() {
  if (!cameraStream || !cameraStream.getVideoTracks()[0]) return alert('ক্যামেরা নেই!');
  const t = cameraStream.getVideoTracks()[0];
  t.enabled = !t.enabled;
  const btn = document.getElementById('video-btn');
  btn.classList.toggle('off-state', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
  if (!screenSharing) {
    outgoingStream = cameraStream;
    renderOwnCard();
  }
}

async function shareScreen() {
  if (!isHost) return alert('শুধু Host screen share করতে পারে!');
  if (screenSharing) return stopScreenShare();

  try {
    activeScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false
    });
    const screenTrack = activeScreenStream.getVideoTracks()[0];
    if (!screenTrack) return;

    screenSharing = true;
    updateScreenBtnUI(true);
    socket.emit('screen-share-started');

    const tracks = [screenTrack];
    const micTrack = cameraStream ? cameraStream.getAudioTracks()[0] : null;
    if (micTrack) tracks.push(micTrack);
    outgoingStream = new MediaStream(tracks);

    setPresentationStageMode(myPeerId, true);
    renderOwnCard();
    await recallAllPeers(outgoingStream);

    screenTrack.onended = () => stopScreenShare();
  } catch (err) {
    screenSharing = false;
    updateScreenBtnUI(false);
  }
}

async function stopScreenShare() {
  const wasSharing = screenSharing;
  screenSharing = false;
  updateScreenBtnUI(false);
  if (wasSharing) {
    try { socket.emit('screen-share-stopped'); } catch (e) {}
  }
  if (activeScreenStream) {
    activeScreenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    activeScreenStream = null;
  }
  outgoingStream = cameraStream || null;
  setPresentationStageMode(null, false);
  renderOwnCard();
  await recallAllPeers(outgoingStream || new MediaStream());
}

function updateScreenBtnUI(active) {
  const btn = document.getElementById('screen-btn');
  if (!btn) return;
  btn.classList.toggle('off-state', active);
  btn.innerHTML = active ? '<i class="fas fa-times"></i>' : '<i class="fas fa-desktop"></i>';
}

async function recallAllPeers(stream) {
  if (!myPeer) return;
  const ids = Object.keys(peers);
  for (const pid of ids) {
    if (pid === myPeerId) continue;
    try {
      if (peers[pid]) {
        try { peers[pid].close(); } catch (e) {}
        delete peers[pid];
      }
      const call = myPeer.call(pid, stream || new MediaStream());
      bindCallEvents(call, pid);
    } catch (e) { console.warn(e); }
  }
}

function leaveMeeting() {
  if (!confirm('Leave meeting?')) return;
  try {
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    if (activeScreenStream) activeScreenStream.getTracks().forEach(t => t.stop());
    if (myPeer) myPeer.destroy();
  } catch (e) {}
  location.href = '/';
}

function toggleChat() {
  const chat = document.getElementById('chat-window');
  const people = document.getElementById('people-window');
  if (people) people.style.display = 'none';
  if (chat) chat.style.display = (chat.style.display === 'flex') ? 'none' : 'flex';
}

function togglePeople() {
  const people = document.getElementById('people-window');
  const chat = document.getElementById('chat-window');
  if (chat) chat.style.display = 'none';
  if (people) people.style.display = (people.style.display === 'flex') ? 'none' : 'flex';
}

function copyMeetingLink() {
  navigator.clipboard.writeText(location.href);
  alert('Link copied!');
}

function sendMessage() {
  const input = document.getElementById('chat-message-input');
  if (input && input.value.trim()) {
    socket.emit('message', input.value.trim());
    input.value = '';
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter') sendMessage();
}

socket.on('createMessage', (message, sender) => {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg-bubble';
  div.innerHTML = `<div class="msg-sender">${sender}</div><div class="msg-text">${message}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

let sec = 0;
setInterval(() => {
  sec++;
  const el = document.getElementById('meeting-time');
  if (el) {
    el.innerText =
      String(Math.floor(sec / 60)).padStart(2, '0') + ':' +
      String(sec % 60).padStart(2, '0');
  }
}, 1000);
