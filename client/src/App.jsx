import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Hash, Send, User, Shield, MessageSquare, LogOut, Lock, Users, Info } from 'lucide-react';
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
  const [membershipStatus, setMembershipStatus] = useState('none'); // 'none', 'pending', 'approved'
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
      if (userProfile?.email !== data.userEmail) {
        fetchPendingRequests();
      }
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
      const res = await fetch(`${SERVER_URL}/api/requests/${userProfile.email}`);
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
    setPendingRequests(prev => prev.filter(r => r.userEmail !== userEmail || r.roomId !== roomId));
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
      <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: '#0f172a' }}>
        {/* Sidebar */}
        <div className="glass-container" style={{ width: '280px', margin: '15px', display: 'flex', flexDirection: 'column', padding: '20px', gap: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="gradient-text" style={{ fontSize: '1.2rem' }}>SecureChat</h2>
            <button onClick={() => setShowCreateModal('create')} style={{ background: 'var(--primary)', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', color: 'white' }}>
              <Hash size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '0.7rem', fontWeight: 'bold', opacity: 0.4, textTransform: 'uppercase' }}>Active Channels</p>
            {myRooms.map(room => (
              <div
                key={room.id}
                onClick={() => room.status === 'approved' && handleJoinRoom(room.id, room.room_code)}
                className="glass-container"
                style={{
                  padding: '12px',
                  cursor: 'pointer',
                  background: currentRoomId === room.id ? 'var(--primary)' : 'rgba(255,255,255,0.03)',
                  border: '1px solid ' + (currentRoomId === room.id ? 'transparent' : 'var(--glass-border)'),
                  opacity: room.status === 'approved' ? 1 : 0.5
                }}
              >
                <p style={{ fontWeight: '600', fontSize: '0.85rem' }}>{room.name || 'Chat'}</p>
                <p style={{ fontSize: '0.65rem', opacity: 0.6 }}>#{room.id}</p>
              </div>
            ))}
          </div>
          <button onClick={handleLogout} className="btn-primary" style={{ background: 'rgba(255,68,68,0.1)', color: '#ff4444', border: '1px solid rgba(255,68,68,0.2)' }}>Logout</button>
        </div>

        {/* Chat Main Area */}
        <div className="glass-container" style={{ flex: 1, margin: '15px 15px 15px 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ padding: '8px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '10px' }}><MessageSquare size={18} color="#6366f1" /></div>
              <div>
                <h3 style={{ fontSize: '1rem' }}>{myRooms.find(r => r.id === currentRoomId)?.name || 'E2EE Channel'}</h3>
                <p style={{ fontSize: '0.7rem', color: '#10b981' }}>#{currentRoomId} • Online</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {pendingRequests.length > 0 && (
                <button
                  onClick={() => approveRequest(pendingRequests[0].room_id, pendingRequests[0].user_email)}
                  style={{ background: 'var(--secondary)', border: 'none', color: 'white', padding: '5px 12px', borderRadius: '15px', fontSize: '0.7rem', cursor: 'pointer' }}
                >
                  Approve Request
                </button>
              )}
              <button
                onClick={() => setShowActiveMembers(!showActiveMembers)}
                className="btn-primary"
                style={{ background: showActiveMembers ? 'var(--primary)' : 'rgba(255,255,255,0.05)', padding: '8px 15px', fontSize: '0.8rem' }}
              >
                <Users size={16} style={{ marginRight: '6px' }} /> Members ({activeUsers.length})
              </button>
              <button
                onClick={() => setShowRoomDetails(true)}
                className="btn-primary"
                style={{ background: 'rgba(255,255,255,0.05)', padding: '8px 15px', fontSize: '0.8rem' }}
              >
                <Info size={16} />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Messages */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="messages-container" ref={scrollRef} style={{ flex: 1, padding: '20px' }}>
                <AnimatePresence>
                  {messages.map((msg, idx) => (
                    <motion.div key={idx} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className={`message ${msg.sender === userProfile.name ? 'sent' : 'received'}`}>
                      <p style={{ fontSize: '0.65rem', fontWeight: 'bold', marginBottom: '3px', opacity: 0.6 }}>{msg.sender}</p>
                      <div style={{ wordBreak: 'break-word' }}>
                        {msg.type === 'image' ? <img src={msg.message} style={{ maxWidth: '100%', borderRadius: '8px' }} alt="" /> : msg.message}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.6rem', opacity: 0.4 }}>{msg.timestamp}</span>
                        <div style={{ display: 'flex', gap: '5px' }}>
                          <button onClick={() => addReaction(msg.id, '❤️')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.7rem', opacity: 0.4 }}>❤️</button>
                          {msg.expiresAt && <span style={{ fontSize: '0.6rem', color: '#ff4444' }}>🔥 {new Date(msg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              {/* Input */}
              <form onSubmit={sendMessage} style={{ padding: '20px', borderTop: '1px solid var(--glass-border)', display: 'flex', gap: '10px' }}>
                <select
                  value={burnTimer}
                  onChange={e => setBurnTimer(e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '0 10px', fontSize: '0.8rem' }}
                >
                  <option value="none">No Burn</option>
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="1h">1h</option>
                </select>
                <input className="input-field" value={currentMessage} onChange={e => setCurrentMessage(e.target.value)} style={{ flex: 1 }} placeholder="Type an encrypted message..." />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <label className="btn-primary" style={{ padding: '10px', cursor: 'pointer' }}><Hash size={20} /><input type="file" hidden accept="image/*" onChange={handleFileUpload} /></label>
                  <button className="btn-primary" type="submit" style={{ padding: '10px 20px' }}><Send size={20} /></button>
                </div>
              </form>
            </div>

            {/* Members Panel */}
            {showActiveMembers && (
              <div style={{ width: '250px', borderLeft: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.01)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '15px', borderBottom: '1px solid var(--glass-border)', opacity: 0.5, fontSize: '0.7rem', fontWeight: 'bold' }}>MEMBERS ONLINE</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '15px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {activeUsers.map(u => (
                    <div key={u.id} className="glass-container" style={{ padding: '12px', border: '1px solid var(--glass-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                        <img src={u.picture} style={{ width: '28px', height: '28px', borderRadius: '50%' }} alt="" />
                        <p style={{ fontSize: '0.8rem', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.username} {u.email === creatorEmail && '👑'}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button onClick={() => startPrivateChat(u)} disabled={u.email === userProfile.email} style={{ flex: 1, background: 'rgba(99,102,241,0.1)', border: 'none', borderRadius: '4px', color: '#818cf8', fontSize: '0.65rem', padding: '5px', cursor: 'pointer', opacity: u.email === userProfile.email ? 0.2 : 1 }}>DM</button>
                        {userProfile.email === creatorEmail && u.email !== creatorEmail && (
                          <button onClick={() => kickUser(u.email)} style={{ background: 'rgba(255,68,68,0.1)', border: 'none', borderRadius: '4px', color: '#ff4444', fontSize: '0.65rem', padding: '5px', cursor: 'pointer' }}>Kick</button>
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
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="glass-container" style={{ padding: '30px', width: '350px' }}>
              <h3 style={{ marginBottom: '20px' }}>Room Settings</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: '5px' }}>ROOM ID</p>
              <p style={{ fontWeight: 'bold', marginBottom: '15px', color: 'var(--primary)' }}>#{currentRoomId}</p>
              <p style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: '5px' }}>PRIVATE KEY</p>
              <code style={{ display: 'block', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', marginBottom: '20px' }}>{roomCode}</code>
              <button onClick={() => setShowRoomDetails(false)} className="btn-primary" style={{ width: '100%' }}>Close</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Waiting View
  if (isJoined) {
    return (
      <div className="flex-center" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-container" style={{ padding: '40px', width: '400px', textAlign: 'center' }}>
          <Shield size={48} color="#6366f1" style={{ marginBottom: '20px' }} />
          <h3>{membershipStatus === 'pending' ? 'Request Sent' : 'Initializing...'}</h3>
          <p style={{ opacity: 0.6, fontSize: '0.9rem', marginTop: '10px' }}>
            {membershipStatus === 'pending' ? 'Wait for the room owner to approve your access.' : 'Connecting to secure mesh...'}
          </p>
          <button className="btn-primary" style={{ marginTop: '20px', background: 'transparent', border: '1px solid var(--glass-border)' }} onClick={() => setIsJoined(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  // 3. Welcome View
  return (
    <div className="flex-center" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="glass-container animate-fade-in" style={{ padding: '40px', width: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <div style={{ display: 'inline-flex', padding: '15px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '15px' }}>
            <Shield size={32} color="#6366f1" />
          </div>
          <h1 className="gradient-text" style={{ fontSize: '2rem', marginTop: '15px' }}>SecureChat</h1>
          <p style={{ opacity: 0.5, fontSize: '0.9rem' }}>End-to-End Encrypted</p>
        </div>

        {!userProfile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <GoogleLogin onSuccess={handleLoginSuccess} />
            </div>
            <div style={{ textAlign: 'center', opacity: 0.3, fontSize: '0.7rem' }}>OR</div>
            <form onSubmit={handleGuestLogin} style={{ display: 'flex', gap: '10px' }}>
              <input className="input-field" placeholder="Guest Name" value={guestName} onChange={e => setGuestName(e.target.value)} style={{ flex: 1 }} />
              <button className="btn-primary" type="submit">Go</button>
            </form>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '15px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--glass-border)' }}>
              <img src={userProfile.picture} style={{ width: '40px', height: '40px', borderRadius: '50%' }} alt="" />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{userProfile.name}</p>
                <p style={{ fontSize: '0.7rem', opacity: 0.5 }}>{userProfile.email}</p>
              </div>
              <button onClick={() => setUserProfile(null)} style={{ background: 'transparent', border: 'none', color: '#ff4444' }}><LogOut size={16} /></button>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="btn-primary" style={{ flex: 1 }} onClick={() => setShowCreateModal('create')}>Create</button>
              <button className="btn-primary" style={{ flex: 1, background: 'transparent', border: '1px solid var(--glass-border)' }} onClick={() => setShowCreateModal('join')}>Join</button>
            </div>
            {myRooms.length > 0 && (
              <div style={{ marginTop: '10px' }}>
                <p style={{ fontSize: '0.7rem', fontWeight: 'bold', opacity: 0.4, marginBottom: '10px' }}>FREQUENT ROOMS</p>
                {myRooms.map(r => (
                  <button key={r.id} onClick={() => handleJoinRoom(r.id, r.room_code || '')} className="glass-container" style={{ width: '100%', textAlign: 'left', padding: '12px', marginBottom: '8px', cursor: 'pointer' }}>
                    {r.name} <span style={{ opacity: 0.5, fontSize: '0.7rem' }}>#{r.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-container" style={{ padding: '30px', width: '380px' }}>
            <h2>{showCreateModal === 'join' ? 'Join' : 'Create'} Secure Room</h2>
            <form onSubmit={showCreateModal === 'join' ? (e) => { e.preventDefault(); handleJoinRoom(currentRoomId, roomCode); } : handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
              {showCreateModal === 'create' && <input className="input-field" placeholder="Room Name" value={roomName} onChange={e => setRoomName(e.target.value)} required />}
              <input className="input-field" placeholder="Room ID (e.g. #ABCD)" value={currentRoomId} onChange={e => setCurrentRoomId(e.target.value.toUpperCase())} required />
              <input className="input-field" placeholder="Secret Key (Room Code)" type="password" value={roomCode} onChange={e => setRoomCode(e.target.value)} required />
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button className="btn-primary" type="submit" style={{ flex: 2 }}>{showCreateModal === 'join' ? 'Access' : 'Generate'}</button>
                <button className="btn-primary" type="button" onClick={() => setShowCreateModal(false)} style={{ flex: 1, background: 'transparent', border: '1px solid var(--glass-border)' }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
