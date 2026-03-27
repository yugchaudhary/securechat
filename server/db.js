import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  creator_email: { type: String, required: true },
  room_code: { type: String },
  last_active_at: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now }
});

const MembershipSchema = new mongoose.Schema({
  room_id: { type: String, required: true },
  user_email: { type: String, required: true },
  status: { type: String, default: 'pending' }
});
MembershipSchema.index({ room_id: 1, user_email: 1 }, { unique: true });

const MessageSchema = new mongoose.Schema({
  room_id: { type: String, required: true },
  sender_name: { type: String },
  sender_email: { type: String },
  encrypted_blob: { type: String, required: true },
  type: { type: String, default: 'text' },
  expires_at: { type: Date },
  timestamp: { type: String }
});

export const Room = mongoose.model('Room', RoomSchema);
export const Membership = mongoose.model('Membership', MembershipSchema);
export const Message = mongoose.model('Message', MessageSchema);

export const dbOps = {
  createRoom: async (roomId, name, creatorEmail, roomCode) => {
    const room = new Room({ id: roomId, name, creator_email: creatorEmail, room_code: roomCode });
    await room.save();
    const membership = new Membership({ room_id: roomId, user_email: creatorEmail, status: 'approved' });
    await membership.save();
  },

  getRoom: async (roomId) => {
    return await Room.findOne({ id: roomId });
  },

  updateRoomName: async (roomId, name) => {
    await Room.updateOne({ id: roomId }, { name });
  },

  addMembershipRequest: async (roomId, userEmail) => {
    try {
      const membership = new Membership({ room_id: roomId, user_email: userEmail, status: 'pending' });
      await membership.save();
    } catch (err) {
      // Already exists
    }
  },

  approveMembership: async (roomId, userEmail) => {
    await Membership.updateOne({ room_id: roomId, user_email: userEmail }, { status: 'approved' });
  },

  isMember: async (roomId, userEmail) => {
    const m = await Membership.findOne({ room_id: roomId, user_email: userEmail, status: 'approved' });
    return !!m;
  },

  getMemberships: async (userEmail) => {
    const memberships = await Membership.find({ user_email: userEmail });
    const roomIds = memberships.map(m => m.room_id);
    const rooms = await Room.find({ id: { $in: roomIds } });
    return rooms.map(r => ({
      ...r.toObject(),
      status: memberships.find(m => m.room_id === r.id)?.status
    }));
  },

  getPendingRequestsForAdmin: async (adminEmail) => {
    const myRooms = await Room.find({ creator_email: adminEmail });
    const roomIds = myRooms.map(r => r.id);
    const pending = await Membership.find({ room_id: { $in: roomIds }, status: 'pending' });
    return pending.map(p => ({
      room_id: p.room_id,
      user_email: p.user_email,
      room_name: myRooms.find(r => r.id === p.room_id)?.name
    }));
  },

  saveMessage: async (roomId, senderName, senderEmail, blob, timestamp, type, expiresAt) => {
    const msg = new Message({
      room_id: roomId,
      sender_name: senderName,
      sender_email: senderEmail,
      encrypted_blob: blob,
      timestamp,
      type,
      expires_at: expiresAt ? new Date(expiresAt) : null
    });
    await msg.save();
    await Room.updateOne({ id: roomId }, { last_active_at: new Date() });
  },

  getMessageHistory: async (roomId) => {
    return await Message.find({ room_id: roomId }).sort({ _id: 1 });
  },

  deleteInactiveRooms: async (days) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const inactiveRooms = await Room.find({ last_active_at: { $lt: cutoff } });
    const roomIds = inactiveRooms.map(r => r.id);
    if (roomIds.length > 0) {
      await Room.deleteMany({ id: { $in: roomIds } });
      await Membership.deleteMany({ room_id: { $in: roomIds } });
      await Message.deleteMany({ room_id: { $in: roomIds } });
    }
    return roomIds.length;
  }
};
