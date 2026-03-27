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
  status: { type: String, default: 'pending' } // 'pending', 'approved'
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
    // Creator is automatically approved
  },

  isMember: (roomId, userEmail) => {
    const membership = db.prepare('SELECT status FROM memberships WHERE room_id = ? AND user_email = ?').get(roomId, userEmail);
    return membership && membership.status === 'approved';
  }
};

export default db;
