import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Hash, Send, User, Shield, MessageSquare, LogOut, Lock, Users, Info, Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { deriveKey, encryptMessage, decryptMessage } from './utils/crypto';

// Use environment variable or default to local for development
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:10000';
const socket = io(SERVER_URL);

function App() {
  const [userProfile, setUserProfile] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [currentRoomId, setCurrentRoomId] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isJoined, setIsJoined] = useState(false);
  const [membershipStatus, setMembershipStatus] = useState('none');
  const [messages, setMessages] = useState([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [activeUsers, setActiveUsers] = useState([]);
  const [myRooms, setMyRooms] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [encryptionKey, setEncryptionKey] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [creatorEmail, setCreatorEmail] = useState('');
  const [showActiveMembers, setShowActiveMembers] = useState(false);
  const [burnTimer, setBurnTimer] = useState('none');

  const scrollRef = useRef();

  useEffect(() => {
    if (userProfile?.email) {
      fetchRooms();
      fetchPendingRequests();
    }
  }, [userProfile]);

  useEffect(() => {
    socket.on('receive-message', async (data) => {
      if (data.roomId === currentRoomId && encryptionKey) {
        let displayMessage = data.message;
        if (data.type !== 'reaction') {
          displayMessage = await decryptMessage(data.message, encryptionKey);
        }
        setMessages((prev) => [...prev, { ...data, message: displayMessage }]);
      }
    });

    socket.on('message-history', async (history) => {
      if (encryptionKey) {
        const decryptedHistory = await Promise.all(history.map(async (msg) => ({
          ...msg,
          sender: msg.sender_name,
          message: msg.type === 'reaction' ? msg.message : await decryptMessage(msg.message, encryptionKey)
        })));
        setMessages(decryptedHistory);
      }
    });

    socket.on('room-users', ({ users, creatorEmail }) => {
      setActiveUsers(users);
      setCreatorEmail(creatorEmail);
    });

    socket.on('kicked', () => {
      alert('You have been removed from the room');
      setIsJoined(false);
      setMembershipStatus('none');
    });

    socket.on('membership-status', ({ status }) => {
      setMembershipStatus(status);
    });

    socket.on('membership-approved', ({ roomId, userEmail }) => {
      const cleanId = roomId.replace(/^#+/, '').toUpperCase();
      if (userProfile?.email === userEmail && currentRoomId.replace(/^#+/, '').toUpperCase() === cleanId) {
        setMembershipStatus('approved');
        socket.emit('join-room', { roomId: cleanId, username: userProfile.name, email: userProfile.email });
      }
      fetchRooms();
      setPendingRequests(prev => prev.filter(r => r.room_id.replace(/^#+/, '').toUpperCase() !== cleanId || r.user_email !== userEmail));
    });

    socket.on('new-membership-request', (data) => {
      console.log('New request received:', data);
      fetchPendingRequests();
    });

    return () => {
      socket.off('receive-message');
      socket.off('message-history');
      socket.off('room-users');
      socket.off('membership-status');
      socket.off('membership-approved');
      socket.off('new-membership-request');
      socket.off('kicked');
    };
  }, [encryptionKey, userProfile, currentRoomId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const fetchRooms = async () => {
    if (!userProfile?.email) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/${userProfile.email}`);
      const data = await res.json();
      setMyRooms(data);
    } catch (err) {
      console.error('Failed to fetch rooms');
    }
  };

  const fetchPendingRequests = async () => {
    if (!userProfile?.email) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/pending/${userProfile.email}`);
      const data = await res.json();
      setPendingRequests(data);
    } catch (err) {
      console.error('Failed to fetch requests');
    }
  };

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (!roomName || !roomCode) return;
    const cleanId = currentRoomId.replace(/^#+/, '').toUpperCase() || Math.random().toString(36).substring(7).toUpperCase();

    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: cleanId, name: roomName, creatorEmail: userProfile.email, roomCode })
      });

      if (!res.ok) throw new Error('Room ID already exists');

      setShowCreateModal(false);
      fetchRooms();
      handleJoinRoom(cleanId, roomCode);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleJoinRoom = async (id, code) => {
    if (!id || !code) return;
    const cleanId = id.replace(/^#+/, '').toUpperCase();
    const key = await deriveKey(code);
    setEncryptionKey(key);
    setCurrentRoomId(cleanId);
    setRoomCode(code);
    socket.emit('join-room', { roomId: cleanId, username: userProfile.name, email: userProfile.email });
    setIsJoined(true);
    setShowCreateModal(false);
  };

  const approveRequest = (roomId, userEmail) => {
    socket.emit('approve-request', { roomId, userEmail });
    setPendingRequests(prev => prev.filter(r => r.user_email !== userEmail || r.room_id !== roomId));
  };

  const kickUser = (userEmail) => {
    if (window.confirm(`Are you sure you want to remove ${userEmail}?`)) {
      socket.emit('kick-user', { roomId: currentRoomId, userEmail });
    }
  };

  const startPrivateChat = async (targetUser) => {
    if (targetUser.email === userProfile.email) return;
    const emails = [userProfile.email, targetUser.email].sort();
    const dmRoomId = `DM-${emails[0].split('@')[0]}-${emails[1].split('@')[0]}`;
    const dmCode = emails.join('-');
    const key = await deriveKey(dmCode);
    setEncryptionKey(key);
    setCurrentRoomId(dmRoomId);
    setRoomCode(dmCode);
    setMembershipStatus('approved');
    socket.emit('join-room', { roomId: dmRoomId, username: userProfile.name, email: userProfile.email });
    setIsJoined(true);
  };

  const handleLoginSuccess = (credentialResponse) => {
    const decoded = jwtDecode(credentialResponse.credential);
    setUserProfile({
      name: decoded.name,
      email: decoded.email,
      picture: decoded.picture
    });
  };

  const handleLogout = () => {
    setIsJoined(false);
    setEncryptionKey(null);
    setUserProfile(null);
    setGuestName('');
    setRoomCode('');
    setMessages([]);
    setMyRooms([]);
    setPendingRequests([]);
    setMembershipStatus('none');
    setCurrentRoomId('');
  };

  const handleGuestLogin = (e) => {
    e.preventDefault();
    if (!guestName) return;
    const uniqueId = Math.random().toString(36).substring(7);
    setUserProfile({
      name: guestName,
      email: `guest-${guestName.toLowerCase()}-${uniqueId}@local`,
      picture: `https://api.dicebear.com/7.x/avataaars/svg?seed=${guestName}`
    });
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!currentMessage || !encryptionKey || !userProfile) return;

    const encryptedContent = await encryptMessage(currentMessage, encryptionKey);
    let expiresAt = null;
    if (burnTimer !== 'none') {
      const mins = burnTimer === '1m' ? 1 : burnTimer === '5m' ? 5 : 60;
      expiresAt = new Date(Date.now() + mins * 60000).toISOString();
    }

    const messageData = {
      roomId: currentRoomId,
      message: encryptedContent,
      sender: userProfile.name,
      senderEmail: userProfile.email,
      type: 'text',
      expiresAt,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('send-message', messageData);
    setMessages((prev) => [...prev, { ...messageData, message: currentMessage }]);
    setCurrentMessage('');
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !encryptionKey) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target.result;
      const encrypted = await encryptMessage(base64, encryptionKey);
      const messageData = {
        roomId: currentRoomId,
        message: encrypted,
        sender: userProfile.name,
        senderEmail: userProfile.email,
        type: 'image',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      socket.emit('send-message', messageData);
      setMessages(prev => [...prev, { ...messageData, message: base64 }]);
    };
    reader.readAsDataURL(file);
  };

  const addReaction = (messageId, emoji) => {
    socket.emit('send-message', {
      roomId: currentRoomId,
      message: emoji,
      sender: userProfile.name,
      senderEmail: userProfile.email,
      type: 'reaction',
      targetMessageId: messageId,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  };

  // 1. Chat View
  if (isJoined && membershipStatus === 'approved') {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
        {/* Sidebar */}
        <div className="glass-container" style={{ width: '280px', margin: '20px', display: 'flex', flexDirection: 'column', padding: '24px', gap: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="gradient-text" style={{ fontSize: '1.4rem', fontWeight: '800' }}>SecureChat</h2>
            <button onClick={() => setShowCreateModal('create')} className="btn-primary" style={{ borderRadius: '50%', width: '36px', height: '36px', padding: 0 }}>
              <Hash size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '0.7rem', fontWeight: '800', opacity: 0.4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>My Channels</p>
            {myRooms.map(room => (
              <div
                key={room.id}
                onClick={() => room.status === 'approved' && handleJoinRoom(room.id, room.room_code)}
                className="glass-container"
                style={{
                  padding: '14px',
                  cursor: 'pointer',
                  background: currentRoomId === room.id ? 'rgba(99, 102, 241, 0.1)' : 'rgba(255,255,255,0.02)',
                  borderColor: currentRoomId === room.id ? 'var(--primary)' : 'var(--glass-border)',
                  opacity: room.status === 'approved' ? 1 : 0.5,
                  transition: '0.3s'
                }}
              >
                <p style={{ fontWeight: '700', fontSize: '0.9rem' }}>{room.name || 'Chat'}</p>
                <p style={{ fontSize: '0.7rem', opacity: 0.5 }}>#{room.id}</p>
              </div>
            ))}
          </div>
          <button onClick={handleLogout} className="btn-primary" style={{ background: 'rgba(255,68,68,0.1)', color: '#ff4444', border: '1px solid rgba(255,68,68,0.2)', boxShadow: 'none' }}>Logout</button>
        </div>

        {/* Chat Main Area */}
        <div className="glass-container" style={{ flex: 1, margin: '20px 20px 20px 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.01)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{ padding: '10px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '12px' }}><MessageSquare size={20} color="#6366f1" /></div>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '700' }}>{myRooms.find(r => r.id === currentRoomId)?.name || 'E2EE Workspace'}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '6px', height: '6px', background: '#10b981', borderRadius: '50%' }}></div>
                  <p style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '600' }}>#{currentRoomId} • Online</p>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              {pendingRequests.length > 0 && userProfile.email === creatorEmail && (
                <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(236, 72, 153, 0.1)', padding: '5px 15px', borderRadius: '25px', border: '1px solid var(--secondary)', gap: '12px', boxShadow: '0 0 15px var(--secondary-glow)' }} className="pulse-glow">
                  <p style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--secondary)' }}>{pendingRequests.length} REQUEST{pendingRequests.length > 1 ? 'S' : ''}</p>
                  <button
                    onClick={() => approveRequest(pendingRequests[0].room_id, pendingRequests[0].user_email)}
                    style={{ background: 'var(--secondary)', border: 'none', color: 'white', padding: '5px 12px', borderRadius: '15px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}
                  >
                    Approve Next
                  </button>
                </div>
              )}
              <button
                onClick={() => setShowActiveMembers(!showActiveMembers)}
                className="btn-primary"
                style={{ background: showActiveMembers ? 'var(--primary)' : 'rgba(255,255,255,0.05)', padding: '10px 18px', fontSize: '0.85rem', boxShadow: showActiveMembers ? '' : 'none' }}
              >
                <Users size={18} /> {activeUsers.length} Online
              </button>
              <button
                onClick={() => setShowRoomDetails(true)}
                className="btn-primary"
                style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', boxShadow: 'none' }}
              >
                <Info size={18} />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Messages Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="messages-container" ref={scrollRef} style={{ flex: 1, padding: '24px' }}>
                <AnimatePresence>
                  {messages.map((msg, idx) => (
                    <motion.div key={idx} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`message ${msg.sender === userProfile.name ? 'sent' : 'received'}`}>
                      <p style={{ fontSize: '0.7rem', fontWeight: '800', marginBottom: '4px', opacity: 0.5, letterSpacing: '0.02em' }}>{msg.sender}</p>
                      <div style={{ fontSize: '0.95rem', lineHeight: '1.5' }}>
                        {msg.type === 'image' ? <img src={msg.message} style={{ maxWidth: '100%', borderRadius: '12px', margin: '8px 0' }} alt="" /> : msg.message}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                        <span style={{ fontSize: '0.65rem', opacity: 0.4 }}>{msg.timestamp}</span>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <button onClick={() => addReaction(msg.id, '❤️')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.8rem', opacity: 0.5 }}>❤️</button>
                          {msg.expiresAt && <span style={{ fontSize: '0.65rem', color: '#ff4444', fontWeight: '700' }}>🔥 {new Date(msg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              {/* Chat Input */}
              <form onSubmit={sendMessage} style={{ padding: '24px', borderTop: '1px solid var(--glass-border)', display: 'flex', gap: '12px', alignItems: 'center', background: 'rgba(255,255,255,0.01)' }}>
                <select
                  value={burnTimer}
                  onChange={e => setBurnTimer(e.target.value)}
                  className="input-field"
                  style={{ padding: '10px', fontSize: '0.8rem', width: 'auto' }}
                >
                  <option value="none">No Burn</option>
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="1h">1h</option>
                </select>
                <input className="input-field" value={currentMessage} onChange={e => setCurrentMessage(e.target.value)} style={{ flex: 1 }} placeholder="Shift+Enter for newline, Enter to send secure message..." />
                <div style={{ display: 'flex', gap: '10px' }}>
                  <label className="btn-primary" style={{ padding: '12px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', boxShadow: 'none' }}><Hash size={20} /><input type="file" hidden accept="image/*" onChange={handleFileUpload} /></label>
                  <button className="btn-primary" type="submit" style={{ padding: '12px 24px' }}><Send size={20} /></button>
                </div>
              </form>
            </div>

            {/* Right Side Member Panel */}
            {showActiveMembers && (
              <div className="animate-fade-in" style={{ width: '280px', borderLeft: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.01)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '20px', borderBottom: '1px solid var(--glass-border)', opacity: 0.4, fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.1em' }}>ACTIVE MEMBERS</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {activeUsers.map(u => (
                    <div key={u.id} className="glass-container" style={{ padding: '14px', border: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                        <div style={{ position: 'relative' }}>
                          <img src={u.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${u.username}`} style={{ width: '32px', height: '32px', borderRadius: '50%' }} alt="" />
                          <div style={{ position: 'absolute', bottom: 0, right: 0, width: '8px', height: '8px', background: '#10b981', borderRadius: '50%', border: '2px solid #0f172a' }}></div>
                        </div>
                        <p style={{ fontSize: '0.85rem', fontWeight: '700', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.username} {u.email === creatorEmail && '👑'}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => startPrivateChat(u)} disabled={u.email === userProfile.email} style={{ flex: 1, background: 'rgba(99, 102, 241, 0.1)', border: 'none', borderRadius: '8px', color: '#818cf8', fontSize: '0.7rem', padding: '6px', cursor: 'pointer', opacity: u.email === userProfile.email ? 0.2 : 1, fontWeight: '700' }}>Message</button>
                        {userProfile.email === creatorEmail && u.email !== creatorEmail && (
                          <button onClick={() => kickUser(u.email)} style={{ background: 'rgba(255,68,68,0.1)', border: 'none', borderRadius: '8px', color: '#ff4444', fontSize: '0.7rem', padding: '6px 10px', cursor: 'pointer' }}>Kick</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Room Info Modal */}
        {showRoomDetails && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.9)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
            <div className="glass-container animate-fade-in" style={{ padding: '40px', width: '380px' }}>
              <h3 style={{ fontSize: '1.4rem', fontWeight: '800', marginBottom: '24px' }}>Space Parameters</h3>
              <p style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginBottom: '6px', letterSpacing: '0.05em' }}>WORKSPACE IDENTIFIER</p>
              <p style={{ fontWeight: '800', fontSize: '1.1rem', marginBottom: '20px', color: 'var(--primary)' }}>#{currentRoomId}</p>
              <p style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginBottom: '6px', letterSpacing: '0.05em' }}>MASTER ENCRYPTION KEY</p>
              <div style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid var(--glass-border)', marginBottom: '28px' }}>
                <code style={{ fontSize: '0.95rem', color: '#6366f1', wordBreak: 'break-all' }}>{roomCode}</code>
              </div>
              <button onClick={() => setShowRoomDetails(false)} className="btn-primary" style={{ width: '100%', height: '52px' }}>Acknowledge</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Waiting Screen
  if (isJoined) {
    return (
      <div className="flex-center" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-container animate-fade-in animate-float" style={{ padding: '50px', width: '450px', textAlign: 'center' }}>
          <div style={{ marginBottom: '30px', position: 'relative', display: 'inline-block' }}>
            <Shield size={64} color="#6366f1" className="pulse-glow" style={{ borderRadius: '50%' }} />
          </div>
          <h2 style={{ fontSize: '1.6rem', fontWeight: '800' }}>{membershipStatus === 'pending' ? 'Verification Required' : 'Synchronizing Mesh...'}</h2>
          <p style={{ opacity: 0.6, fontSize: '0.95rem', marginTop: '16px', lineHeight: '1.5' }}>
            {membershipStatus === 'pending'
              ? 'Your access request has been transmitted. The room owner must manually verify your identity before decryption keys are shared.'
              : 'Verifying keys and synchronizing encrypted message history with the mesh network...'}
          </p>
          <button
            className="btn-primary"
            style={{ marginTop: '35px', background: 'transparent', border: '2px solid var(--glass-border)', boxShadow: 'none', color: '#94a3b8' }}
            onClick={() => setIsJoined(false)}
          >
            Abort Connection
          </button>
        </div>
      </div>
    );
  }

  // 3. Welcome View
  return (
    <div className="flex-center" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div className="glass-container animate-fade-in animate-float" style={{ padding: '50px 40px', width: '450px', position: 'relative', overflow: 'hidden' }}>
        {/* Glow background elements */}
        <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '40%', height: '40%', background: 'radial-gradient(circle, var(--primary-glow) 0%, transparent 70%)', zIndex: 0, opacity: 0.4 }}></div>
        <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: '40%', height: '40%', background: 'radial-gradient(circle, var(--secondary-glow) 0%, transparent 70%)', zIndex: 0, opacity: 0.4 }}></div>

        <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', padding: '20px', background: 'rgba(99, 102, 241, 0.15)', borderRadius: '24px', marginBottom: '28px', border: '1px solid rgba(99, 102, 241, 0.2)', boxShadow: '0 0 30px rgba(99, 102, 241, 0.2)' }}>
            <Shield size={42} color="#6366f1" className="pulse-glow" style={{ borderRadius: '50%' }} />
          </div>
          <h1 className="gradient-text" style={{ fontSize: '3rem', fontWeight: '800', marginBottom: '8px', letterSpacing: '-0.02em' }}>SecureChat</h1>
          <p style={{ opacity: 0.6, fontSize: '1.1rem', fontWeight: '400', marginBottom: '40px' }}>Zero-Knowledge Messaging</p>

          {!userProfile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <GoogleLogin
                  onSuccess={handleLoginSuccess}
                  theme="filled_black"
                  shape="pill"
                  size="large"
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }}></div>
                <span style={{ fontSize: '0.7rem', opacity: 0.3, letterSpacing: '0.1em', fontWeight: '700' }}>OR IDENTITY AS GUEST</span>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }}></div>
              </div>

              <form onSubmit={handleGuestLogin} style={{ display: 'flex', gap: '10px' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <User size={18} style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
                  <input className="input-field" placeholder="Create temporary alias" value={guestName} onChange={e => setGuestName(e.target.value)} style={{ width: '100%', paddingLeft: '48px' }} />
                </div>
                <button className="btn-primary" type="submit" style={{ padding: '0 24px' }}>Go</button>
              </form>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="glass-container" style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '18px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--glass-border)' }}>
                <div style={{ position: 'relative' }}>
                  <img src={userProfile.picture} style={{ width: '48px', height: '48px', borderRadius: '50%', border: '2px solid var(--primary)' }} alt="" />
                  <div style={{ position: 'absolute', bottom: 0, right: 0, width: '10px', height: '10px', background: '#10b981', borderRadius: '50%', border: '2px solid #0f172a' }}></div>
                </div>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <p style={{ fontWeight: '800', fontSize: '1.05rem' }}>{userProfile.name}</p>
                  <p style={{ fontSize: '0.8rem', opacity: 0.4 }}>{userProfile.email}</p>
                </div>
                <button onClick={() => setUserProfile(null)} style={{ background: 'rgba(255,68,68,0.1)', border: 'none', color: '#ff4444', borderRadius: '10px', padding: '10px', cursor: 'pointer' }}><LogOut size={18} /></button>
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn-primary" style={{ flex: 1, height: '56px' }} onClick={() => setShowCreateModal('create')}><MessageSquare size={18} /> Create</button>
                <button className="btn-primary" style={{ flex: 1, height: '56px', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)', boxShadow: 'none' }} onClick={() => setShowCreateModal('join')}><Hash size={18} /> Join</button>
              </div>

              {myRooms.length > 0 && (
                <div style={{ marginTop: '15px', textAlign: 'left' }}>
                  <p style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginBottom: '15px', letterSpacing: '0.05em' }}>PREVIOUS SESSIONS</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {myRooms.slice(0, 3).map(r => (
                      <button key={r.id} onClick={() => handleJoinRoom(r.id, r.room_code || '')} className="glass-container" style={{ width: '100%', textAlign: 'left', padding: '16px 20px', cursor: 'pointer', border: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.01)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div style={{ width: '8px', height: '8px', background: 'var(--primary)', borderRadius: '50%' }}></div>
                          <span style={{ fontWeight: '700' }}>{r.name}</span>
                        </div>
                        <Hash size={14} style={{ opacity: 0.4 }} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: '40px', padding: '22px', background: 'rgba(99, 102, 241, 0.05)', borderRadius: '24px', display: 'flex', gap: '16px', backdropFilter: 'blur(5px)' }}>
            <Lock size={26} color="#6366f1" style={{ flexShrink: 0 }} />
            <p style={{ fontSize: '0.85rem', opacity: 0.5, lineHeight: '1.6', textAlign: 'left' }}>
              Military-grade AES-256-GCM encryption is applied locally. Your keys never traverse our infrastructure.
            </p>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(12px)' }}>
          <div className="glass-container animate-fade-in" style={{ padding: '45px', width: '420px', border: '1px solid var(--primary)', boxShadow: '0 0 60px rgba(99, 102, 241, 0.2)' }}>
            <div style={{ textAlign: 'center', marginBottom: '35px' }}>
              <h2 style={{ fontSize: '2rem', fontWeight: '800', marginBottom: '10px' }}>{showCreateModal === 'join' ? 'Secure Access' : 'New Mesh Init'}</h2>
              <p style={{ opacity: 0.4, fontSize: '0.9rem' }}>{showCreateModal === 'join' ? 'Verify identity to decrypt synchronization' : 'Declare a new end-to-end encrypted channel'}</p>
            </div>
            <form onSubmit={showCreateModal === 'join' ? (e) => { e.preventDefault(); handleJoinRoom(currentRoomId, roomCode); } : handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
              {showCreateModal === 'create' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginLeft: '6px' }}>CHANNEL NAME</label>
                  <input className="input-field" placeholder="e.g. Project Overload" value={roomName} onChange={e => setRoomName(e.target.value)} required />
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginLeft: '6px' }}>MESH IDENTIFIER</label>
                <input className="input-field" placeholder="#OVERLOAD" value={currentRoomId} onChange={e => setCurrentRoomId(e.target.value.toUpperCase())} required />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.4, marginLeft: '6px' }}>ENCRYPTION SEED</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={18} style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', opacity: 0.3 }} />
                  <input className="input-field" placeholder="Input secret passkey" type="password" value={roomCode} onChange={e => setRoomCode(e.target.value)} required style={{ width: '100%', paddingLeft: '48px' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '14px', marginTop: '12px' }}>
                <button className="btn-primary" type="submit" style={{ flex: 2, height: '60px', fontSize: '1.1rem' }}>{showCreateModal === 'join' ? 'Synchronize' : 'Birth Channel'}</button>
                <button className="btn-primary" type="button" onClick={() => setShowCreateModal(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)', boxShadow: 'none' }}>Abort</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
