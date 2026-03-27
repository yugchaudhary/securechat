import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import { dbOps } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e7 // 10MB
});

// MongoDB Connection
const MONGODB_URI = process.env.DATABASE_URL || 'mongodb://localhost:27017/securechat';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// In-memory tracking for active users
const roomUsers = new Map(); // roomId -> Set of socketIds
const socketInfo = new Map(); // socketId -> { roomId, username, email }

let messageCounter = Date.now();
function getNextId() { return (messageCounter++).toString(36); }

async function updateRoomUsers(roomId) {
  const users = Array.from(roomUsers.get(roomId) || [])
    .map(id => socketInfo.get(id))
    .filter(Boolean);

  const room = await dbOps.getRoom(roomId);
  io.to(roomId).emit('room-users', {
    users,
    creatorEmail: room?.creator_email
  });
}

const PORT = process.env.PORT || 3001;

// API Endpoints
app.get('/api/rooms/:email', async (req, res) => {
  const rooms = await dbOps.getMemberships(req.params.email);
  res.json(rooms);
});

app.post('/api/rooms/create', async (req, res) => {
  const { roomId, name, creatorEmail, roomCode } = req.body;
  try {
    await dbOps.createRoom(roomId, name, creatorEmail, roomCode);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Room ID already exists' });
  }
});

app.post('/api/rooms/update', async (req, res) => {
  const { roomId, name, creatorEmail } = req.body;
  const room = await dbOps.getRoom(roomId);
  if (room && room.creator_email === creatorEmail) {
    await dbOps.updateRoomName(roomId, name);
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Unauthorized' });
  }
});

app.get('/api/pending/:email', async (req, res) => {
  const requests = await dbOps.getPendingRequestsForAdmin(req.params.email);
  res.json(requests);
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', async ({ roomId, username, email }) => {
    // Check membership
    const isMember = await dbOps.isMember(roomId, email);
    const room = await dbOps.getRoom(roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (!isMember) {
      await dbOps.addMembershipRequest(roomId, email);
      socket.emit('membership-status', { status: 'pending' });

      // Notify admin if online
      io.emit('new-membership-request', { roomId, roomName: room.name, userEmail: email, userName: username });
      return;
    }

    socket.join(roomId);
    socket.username = username;
    socket.userEmail = email;
    socket.roomId = roomId;

    // Track user
    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
    roomUsers.get(roomId).add(socket.id);
    socketInfo.set(socket.id, { id: socket.id, username, email, roomId });

    console.log(`User ${username} (${email}) joined room: ${roomId}`);

    // Update user list for the room
    updateRoomUsers(roomId);

    // Send message history
    const history = await dbOps.getMessageHistory(roomId);
    socket.emit('message-history', history.map(h => ({
      id: h.id || h._id.toString(),
      message: h.encrypted_blob,
      sender: h.sender_name,
      senderEmail: h.sender_email,
      timestamp: h.timestamp,
      type: h.type,
      expiresAt: h.expires_at,
      targetMessageId: h.targetMessageId || null
    })));

    // Notify others
    socket.to(roomId).emit('user-joined', { username, id: socket.id });

    // Send status back to the user
    socket.emit('membership-status', { status: 'approved' });
  });

  socket.on('approve-request', async ({ roomId, userEmail }) => {
    await dbOps.approveMembership(roomId, userEmail);
    io.emit('membership-approved', { roomId, userEmail });
    // Also notify the admin themselves so they can clear UI popups
    socket.emit('request-approved-local', { roomId, userEmail });
  });

  socket.on('kick-user', async ({ roomId, userEmail }) => {
    const room = await dbOps.getRoom(roomId);
    if (socket.userEmail === room.creator_email) {
      // Find the socket ID of the user being kicked
      for (const [sId, info] of socketInfo.entries()) {
        if (info.email === userEmail && info.roomId === roomId) {
          const targetSocket = io.sockets.sockets.get(sId);
          if (targetSocket) {
            targetSocket.leave(roomId);
            targetSocket.emit('kicked', { roomId });
          }
          break;
        }
      }
    }
  });

  socket.on('leave-room', ({ roomId }) => {
    if (roomId) {
      socket.leave(roomId);
      const users = roomUsers.get(roomId);
      if (users) {
        users.delete(socket.id);
        updateRoomUsers(roomId);
      }
      socketInfo.delete(socket.id);
      socket.roomId = null;
    }
  });

  socket.on('send-message', async ({ roomId, message, sender, senderEmail, timestamp, type = 'text', expiresAt = null, targetMessageId = null }) => {
    const messageId = getNextId();
    // Save to DB
    await dbOps.saveMessage(roomId, sender, senderEmail, message, timestamp, type, expiresAt);

    // Relay encrypted message blob
    io.to(roomId).emit('receive-message', {
      id: messageId,
      roomId,
      message,
      sender,
      senderEmail,
      timestamp,
      type,
      expiresAt,
      targetMessageId
    });
  });

  socket.on('disconnect', () => {
    const info = socketInfo.get(socket.id);
    if (info) {
      const { roomId } = info;
      const users = roomUsers.get(roomId);
      if (users) {
        users.delete(socket.id);
        updateRoomUsers(roomId);
      }
      socketInfo.delete(socket.id);
    }
    console.log('User disconnected:', socket.id);
  });
});

// Periodic Cleanup: Every hour, delete rooms inactive for 7 days
setInterval(async () => {
  console.log('Running inactive room cleanup...');
  const count = await dbOps.deleteInactiveRooms(7);
}, 60 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
