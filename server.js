const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(__dirname));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'vibe.html'));
});

const users = new Map();
const waitingQueue = [];

function getStats() {
  return {
    totalUsers: users.size,
    waiting: waitingQueue.length
  };
}

function broadcastStats() {
  io.emit('stats', getStats());
}

function removeFromQueue(socketId) {
  const index = waitingQueue.findIndex(entry => entry.socketId === socketId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
  }
}

function pairUsers() {
  while (waitingQueue.length >= 2) {
    const first = waitingQueue.shift();
    const second = waitingQueue.shift();
    if (!first || !second) continue;

    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const firstSocket = io.sockets.sockets.get(first.socketId);
    const secondSocket = io.sockets.sockets.get(second.socketId);
    if (!firstSocket || !secondSocket) continue;

    firstSocket.join(roomId);
    secondSocket.join(roomId);

    firstSocket.data.roomId = roomId;
    secondSocket.data.roomId = roomId;
    firstSocket.data.partnerId = secondSocket.id;
    secondSocket.data.partnerId = firstSocket.id;

    firstSocket.emit('match-found', {
      roomId,
      partner: { id: secondSocket.id, name: second.name }
    });
    secondSocket.emit('match-found', {
      roomId,
      partner: { id: firstSocket.id, name: first.name }
    });

    firstSocket.emit('system', { text: `You matched with ${second.name}` });
    secondSocket.emit('system', { text: `You matched with ${first.name}` });
    broadcastStats();
  }
}

function leaveRoom(socket) {
  if (socket.data.roomId) {
    const roomId = socket.data.roomId;
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.partnerId = null;
    socket.to(roomId).emit('system', { text: 'The room has been left.' });
  }
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.partnerId = null;
  socket.data.name = 'Stranger';

  socket.on('join', ({ name }) => {
    const safeName = (name || 'Stranger').trim().slice(0, 20) || 'Stranger';
    socket.data.name = safeName;
    users.set(socket.id, { socketId: socket.id, name: safeName });
    socket.emit('joined', { name: safeName });
    broadcastStats();
  });

  socket.on('find-match', () => {
    const existing = users.get(socket.id);
    if (!existing) {
      socket.emit('error', { message: 'Join first to start matching.' });
      return;
    }

    if (socket.data.roomId) {
      socket.emit('status', { text: 'You are already in a live conversation.' });
      return;
    }

    removeFromQueue(socket.id);
    waitingQueue.push({ socketId: socket.id, name: socket.data.name });
    socket.emit('status', { text: 'Searching for a stranger…' });
    broadcastStats();
    pairUsers();
  });

  socket.on('message', ({ text, roomId }) => {
    if (!roomId || !socket.data.roomId) {
      return;
    }

    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    io.to(roomId).emit('message', {
      id: messageId,
      text: cleanText,
      fromSocketId: socket.id,
      senderName: socket.data.name
    });
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    if (!roomId) return;
    socket.to(roomId).emit('typing', { isTyping, senderName: socket.data.name });
  });

  socket.on('reaction', ({ roomId, messageId, emoji }) => {
    if (!roomId) return;
    io.to(roomId).emit('reaction', { messageId, emoji, senderName: socket.data.name });
  });

  socket.on('voice-offer', ({ roomId, offer, callerName }) => {
    if (!roomId) return;
    socket.to(roomId).emit('voice-offer', { offer, callerName });
  });

  socket.on('voice-answer', ({ roomId, answer }) => {
    if (!roomId) return;
    socket.to(roomId).emit('voice-answer', { answer });
  });

  socket.on('voice-ice', ({ roomId, candidate }) => {
    if (!roomId) return;
    socket.to(roomId).emit('voice-ice', { candidate });
  });

  socket.on('voice-end', ({ roomId }) => {
    if (!roomId) return;
    io.to(roomId).emit('voice-ended');
  });

  socket.on('create-private-room', () => {
    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    leaveRoom(socket);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('private-room-created', { roomId });
  });

  socket.on('join-private-room', ({ roomId }) => {
    if (!roomId) return;
    leaveRoom(socket);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('match-found', { roomId, partner: { id: 'private', name: 'Private room' } });
    socket.emit('system', { text: `Joined private room ${roomId}` });
  });

  socket.on('next-stranger', () => {
    if (socket.data.roomId) {
      const roomId = socket.data.roomId;
      io.to(roomId).emit('system', { text: 'The chat was reset. Finding your next match…' });
      socket.leave(roomId);
      socket.data.roomId = null;
      socket.data.partnerId = null;
      socket.emit('status', { text: 'Looking for a new stranger…' });
      setTimeout(() => socket.emit('find-match'), 250);
    } else {
      socket.emit('status', { text: 'You are not in a chat yet.' });
    }
  });

  socket.on('disconnect', () => {
    users.delete(socket.id);
    removeFromQueue(socket.id);

    if (socket.data.roomId) {
      const roomId = socket.data.roomId;
      socket.to(roomId).emit('system', { text: 'Your chat partner disconnected.' });
    }

    broadcastStats();
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Vibe chat server running on http://localhost:${port}`);
});
