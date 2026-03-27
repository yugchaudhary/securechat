import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Hash, Send, User, Shield, MessageSquare, LogOut, Lock, Users, Info, Bell, Plus, LogIn } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { deriveKey, encryptMessage, decryptMessage } from './utils/crypto';

// Use environment variable or default to local for development
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:10000';
const socket = io(SERVER_URL);

function App() {
  const [userProfile, setUserProfile] = useState(() => {
    const saved = localStorage.getItem('userProfile');
    return saved ? JSON.parse(saved) : null;
  });
  const [guestName, setGuestName] = useState('');
  const [currentRoomId, setCurrentRoomId] = useState(() => localStorage.getItem('currentRoomId') || '');
  const [roomName, setRoomName] = useState('');
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem('roomCode') || '');
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
  const [creatorEmail, setCreatorEmail] = useState('');
  const [showActiveMembers, setShowActiveMembers] = useState(false);
  const [burnTimer, setBurnTimer] = useState('none');

  const scrollRef = useRef();

  // Sync state to LocalStorage
  useEffect(() => {
    if (userProfile) localStorage.setItem('userProfile', JSON.stringify(userProfile));
    else localStorage.removeItem('userProfile');
  }, [userProfile]);

  useEffect(() => {
    if (currentRoomId) localStorage.setItem('currentRoomId', currentRoomId);
    else localStorage.removeItem('currentRoomId');
  }, [currentRoomId]);

  useEffect(() => {
    if (roomCode) localStorage.setItem('roomCode', roomCode);
    else localStorage.removeItem('roomCode');
  }, [roomCode]);

  // Handle Initial Re-auth
  useEffect(() => {
    if (currentRoomId && roomCode && userProfile && !isJoined) {
      handleJoinRoom(currentRoomId, roomCode);
    }
  }, []);

  useEffect(() => {
    if (userProfile?.email) {
      fetchRooms();
      fetchPendingRequests();
    }
  }, [userProfile]);

  useEffect(() => {
    socket.on('receive-message', async (data) => {
      if (data.roomId === currentRoomId && encryptionKey) {
        if (data.type === 'reaction') {
          setMessages(prev => prev.map(m => m.id === data.targetMessageId ? { ...m, reactions: [...(m.reactions || []), data.message] } : m));
          return;
        }
        const displayMessage = await decryptMessage(data.message, encryptionKey);
        setMessages((prev) => [...prev, { ...data, message: displayMessage, reactions: [] }]);
      }
    });

    socket.on('message-history', async (history) => {
      if (encryptionKey) {
        const processed = [];
        const reactions = [];
        history.forEach(m => {
          if (m.type === 'reaction') reactions.push(m);
          else processed.push({ ...m, id: m.id || m._id, reactions: [] });
        });

        const decryptedHistory = await Promise.all(processed.map(async (msg) => ({
          ...msg,
          sender: msg.sender_name || msg.sender,
          message: await decryptMessage(msg.message, encryptionKey)
        })));

        reactions.forEach(r => {
          const target = decryptedHistory.find(m => m.id === r.targetMessageId);
          if (target) target.reactions.push(r.message);
        });

        setMessages(decryptedHistory);
      }
    });

    socket.on('room-users', ({ users, creatorEmail }) => {
      setActiveUsers(users);
      setCreatorEmail(creatorEmail);
    });

    socket.on('kicked', () => {
      alert('You have been removed from the room');
      handleLogout();
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

    socket.on('new-membership-request', () => fetchPendingRequests());

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
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
    const cleanId = (currentRoomId || Math.random().toString(36).substring(7)).replace(/^#+/, '').toUpperCase();
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
    } catch (err) { alert(err.message); }
  };

  const handleJoinRoom = async (id, code) => {
    if (!id || !code) return;
    const cleanId = id.replace(/^#+/, '').toUpperCase();
    const key = await deriveKey(code);
    setEncryptionKey(key);
    setCurrentRoomId(cleanId);
    setRoomCode(code);
    socket.emit('join-room', { roomId: cleanId, username: userProfile?.name || 'Guest', email: userProfile?.email || 'guest@local' });
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
    setUserProfile({ name: decoded.name, email: decoded.email, picture: decoded.picture });
  };

  const handleLogout = () => {
    localStorage.clear();
    setIsJoined(false);
    setEncryptionKey(null);
    setUserProfile(null);
    setRoomCode('');
    setMessages([]);
    setMyRooms([]);
    setPendingRequests([]);
    setMembershipStatus('none');
    setCurrentRoomId('');
    window.location.reload();
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
    const tempId = Date.now().toString();
    const messageData = { id: tempId, roomId: currentRoomId, message: encryptedContent, sender: userProfile.name, senderEmail: userProfile.email, type: 'text', expiresAt, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    socket.emit('send-message', messageData);
    setMessages((prev) => [...prev, { ...messageData, message: currentMessage, reactions: [] }]);
    setCurrentMessage('');
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !encryptionKey) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target.result;
      const encrypted = await encryptMessage(base64, encryptionKey);
      const messageData = { roomId: currentRoomId, message: encrypted, sender: userProfile.name, senderEmail: userProfile.email, type: 'image', timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
      socket.emit('send-message', messageData);
      setMessages(prev => [...prev, { ...messageData, message: base64, reactions: [] }]);
    };
    reader.readAsDataURL(file);
  };

  const addReaction = (messageId, emoji) => {
    socket.emit('send-message', { roomId: currentRoomId, message: emoji, sender: userProfile.name, senderEmail: userProfile.email, type: 'reaction', targetMessageId: messageId, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions: [...(m.reactions || []), emoji] } : m));
  };

  // 1. Chat View
  if (isJoined && membershipStatus === 'approved') {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', padding: '20px', gap: '20px' }}>
        {/* Sidebar */}
        <div className="glass-container" style={{ width: '300px', display: 'flex', flexDirection: 'column', padding: '24px', gap: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="gradient-text" style={{ fontSize: '1.4rem', fontWeight: '800' }}>SecureChat</h2>
            <Shield size={24} color="#6366f1" className="pulse-glow" style={{ borderRadius: '50%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p style={{ fontSize: '0.7rem', fontWeight: '800', opacity: 0.4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Dashboard</p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowCreateModal('create')} className="btn-primary" style={{ flex: 1, padding: '12px', fontSize: '0.8rem' }}><Plus size={16} /> Create</button>
              <button onClick={() => setShowCreateModal('join')} className="btn-primary" style={{ flex: 1, padding: '12px', fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', boxShadow: 'none', border: '1px solid var(--glass-border)' }}><LogIn size={16} /> Join</button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '0.7rem', fontWeight: '800', opacity: 0.4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Active Rooms</p>
            {myRooms.map(room => (
              <div key={room.id} onClick={() => room.status === 'approved' && handleJoinRoom(room.id, room.room_code)} className="glass-container" style={{ padding: '14px', cursor: 'pointer', background: currentRoomId === room.id ? 'rgba(99, 102, 241, 0.1)' : 'rgba(255,255,255,0.02)', borderColor: currentRoomId === room.id ? 'var(--primary)' : 'var(--glass-border)', opacity: room.status === 'approved' ? 1 : 0.5, borderRadius: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: currentRoomId === room.id ? 'var(--primary)' : 'rgba(255,255,255,0.2)' }}></div>
                  <p style={{ fontWeight: '700', fontSize: '0.85rem' }}>{room.name || 'Chat'}</p>
                </div>
                <p style={{ fontSize: '0.65rem', opacity: 0.5, marginLeft: '18px' }}>#{room.id}</p>
              </div>
            ))}
          </div>
          <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px solid var(--glass-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <img src={userProfile?.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${userProfile?.name}`} style={{ width: '36px', height: '36px', borderRadius: '50%' }} alt="" />
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <p style={{ fontSize: '0.85rem', fontWeight: '700' }}>{userProfile?.name}</p>
                <p style={{ fontSize: '0.7rem', opacity: 0.4 }}>Admin View</p>
              </div>
              <button onClick={handleLogout} style={{ background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer' }}><LogOut size={18} /></button>
            </div>
          </div>
        </div>
        {/* Chat Main Area */}
        <div className="glass-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.01)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{ padding: '10px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '12px' }}><MessageSquare size={20} color="#6366f1" /></div>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '800' }}>{myRooms.find(r => r.id === currentRoomId)?.name || 'E2EE Mesh'}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '6px', height: '6px', background: '#10b981', borderRadius: '50%' }}></div>
                  <p style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '600' }}>#{currentRoomId} • Synchronized</p>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              {pendingRequests.length > 0 && userProfile?.email === creatorEmail && (
                <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(236, 72, 153, 0.1)', padding: '5px 15px', borderRadius: '25px', border: '1px solid var(--secondary)', gap: '12px' }} className="pulse-glow">
                  <Bell size={14} color="var(--secondary)" /><p style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--secondary)' }}>{pendingRequests.length} REQUEST</p>
                  <button onClick={() => approveRequest(pendingRequests[0].room_id, pendingRequests[0].user_email)} style={{ background: 'var(--secondary)', border: 'none', color: 'white', padding: '4px 10px', borderRadius: '12px', fontSize: '0.65rem', fontWeight: '800', cursor: 'pointer' }}>Approve</button>
                </div>
              )}
              <button onClick={() => setShowActiveMembers(!showActiveMembers)} className="btn-primary" style={{ background: showActiveMembers ? 'var(--primary)' : 'rgba(255,255,255,0.05)', padding: '10px 18px', fontSize: '0.85rem', boxShadow: 'none' }}><Users size={18} /> {activeUsers.length}</button>
              <button onClick={() => setShowRoomDetails(true)} className="btn-primary" style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', boxShadow: 'none' }}><Info size={18} /></button>
            </div>
          </div>
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div className="messages-container" ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column' }}>
                <AnimatePresence>
                  {messages.map((msg, idx) => (
                    <motion.div key={idx} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className={`message ${msg.sender === userProfile?.name ? 'sent' : 'received'}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: '800', opacity: 0.6 }}>{msg.sender === userProfile?.name ? 'You' : msg.sender}</span>
                        <span style={{ fontSize: '0.6rem', opacity: 0.3 }}>{msg.timestamp}</span>
                      </div>
                      <div style={{ fontSize: '0.95rem', lineHeight: '1.6' }}>
                        {msg.type === 'image' ? <img src={msg.message} style={{ maxWidth: '100%', borderRadius: '12px', margin: '8px 0' }} alt="" /> : msg.message}
                      </div>
                      {(msg.reactions && msg.reactions.length > 0) && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '10px' }}>
                          {msg.reactions.map((r, i) => <span key={i} style={{ padding: '2px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', fontSize: '0.8rem' }}>{r}</span>)}
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px', gap: '8px' }}>
                        <button onClick={() => addReaction(msg.id, '❤️')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.8rem', opacity: 0.4 }}>❤️</button>
                        <button onClick={() => addReaction(msg.id, '👍')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.8rem', opacity: 0.4 }}>👍</button>
                        {msg.expiresAt && <span style={{ fontSize: '0.6rem', color: '#ff4444', fontWeight: '700' }}>🔥 {new Date(msg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
              <div style={{ padding: '24px', borderTop: '1px solid var(--glass-border)', background: 'rgba(2, 6, 23, 0.4)' }}>
                <form onSubmit={sendMessage} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <select value={burnTimer} onChange={e => setBurnTimer(e.target.value)} className="input-field" style={{ padding: '12px', fontSize: '0.75rem', width: 'auto' }}>
                    <option value="none">Standard</option><option value="1m">1m Burn</option><option value="5m">5m Burn</option>
                  </select>
                  <input className="input-field" value={currentMessage} onChange={e => setCurrentMessage(e.target.value)} style={{ flex: 1 }} placeholder="Type a message..." />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <label className="btn-primary" style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', boxShadow: 'none', border: '1px solid var(--glass-border)' }}><Plus size={20} /><input type="file" hidden accept="image/*" onChange={handleFileUpload} /></label>
                    <button className="btn-primary" type="submit" style={{ padding: '12px 24px' }}><Send size={20} /></button>
                  </div>
                </form>
              </div>
            </div>
            {/* Right Member Panel */}
            {showActiveMembers && (
              <div className="animate-fade-in" style={{ width: '300px', borderLeft: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.01)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '20px', borderBottom: '1px solid var(--glass-border)', opacity: 0.4, fontSize: '0.7rem', fontWeight: '800', letterSpacing: '0.1em' }}>MEMBER REGISTRY</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {activeUsers.map(u => (
                    <div key={u.id} className="glass-container" style={{ padding: '16px', border: '1px solid var(--glass-border)', background: 'rgba(255,255,255,0.02)', borderRadius: '20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <div style={{ position: 'relative' }}><img src={u.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${u.username}`} style={{ width: '32px', height: '32px', borderRadius: '50%' }} alt="" /><div style={{ position: 'absolute', bottom: 0, right: 0, width: '8px', height: '8px', background: '#10b981', borderRadius: '50%', border: '2px solid #0f172a' }}></div></div>
                        <p style={{ fontSize: '0.85rem', fontWeight: '700' }}>{u.username} {u.email === creatorEmail && '👑'}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => startPrivateChat(u)} disabled={u.email === userProfile?.email} style={{ flex: 1, background: 'rgba(99, 102, 241, 0.1)', color: '#818cf8', border: 'none', borderRadius: '10px', fontSize: '0.7rem', padding: '8px', cursor: 'pointer', opacity: u.email === userProfile?.email ? 0.3 : 1 }}>Secure DM</button>
                        {userProfile?.email === creatorEmail && u.email !== creatorEmail && (<button onClick={() => kickUser(u.email)} style={{ background: 'rgba(255,68,68,0.1)', color: '#ff4444', border: 'none', borderRadius: '10px', fontSize: '0.7rem', padding: '8px' }}>Kick</button>)}
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
            <div className="glass-container animate-fade-in" style={{ padding: '40px', width: '400px' }}>
              <h3 style={{ fontSize: '1.4rem', fontWeight: '800', marginBottom: '24px' }}>Security Protocol</h3>
              <p style={{ fontSize: '0.7rem', fontWeight: '800', opacity: 0.4, marginBottom: '6px' }}>MESH ID</p>
              <p style={{ fontWeight: '800', fontSize: '1.2rem', marginBottom: '20px', color: 'var(--primary)' }}>#{currentRoomId}</p>
              <p style={{ fontSize: '0.7rem', fontWeight: '800', opacity: 0.4, marginBottom: '6px' }}>AES-256 SEED</p>
              <div style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '16px', border: '1px solid var(--glass-border)', marginBottom: '30px' }}>
                <code style={{ fontSize: '0.9rem', color: '#6366f1', wordBreak: 'break-all' }}>{roomCode}</code>
              </div>
              <button onClick={() => setShowRoomDetails(false)} className="btn-primary" style={{ width: '100%' }}>Dismiss</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Waiting Screen
  if (isJoined) {
    return (
      <div className="flex-center">
        <div className="glass-container animate-fade-in animate-float" style={{ padding: '60px', width: '480px', textAlign: 'center' }}>
          <Shield size={64} color="#6366f1" className="pulse-glow" style={{ borderRadius: '50%', marginBottom: '30px' }} />
          <h2 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '16px' }}>{membershipStatus === 'pending' ? 'Access Denied' : 'Synchronizing...'}</h2>
          <p style={{ opacity: 0.6, fontSize: '0.95rem', lineHeight: '1.6' }}>
            {membershipStatus === 'pending'
              ? 'Your identity is being verified by the Mesh Administrator. Stand by for end-to-end key synchronization.'
              : 'Verifying master keys and downloading encrypted message shards...'}
          </p>
          <button className="btn-primary" style={{ marginTop: '40px', width: '100%', background: 'transparent', border: '2px solid var(--glass-border)', color: '#94a3b8' }} onClick={() => setIsJoined(false)}>Cancel Request</button>
        </div>
      </div>
    );
  }

  // 3. Welcome View
  return (
    <div className="flex-center">
      <div className="glass-container animate-fade-in animate-float" style={{ padding: '60px 40px', width: '460px', textAlign: 'center' }}>
        <Shield size={64} color="#6366f1" className="pulse-glow" style={{ borderRadius: '50%', marginBottom: '30px' }} />
        <h1 className="gradient-text" style={{ fontSize: '3.5rem', fontWeight: '800', marginBottom: '8px' }}>SecureChat</h1>
        <p style={{ opacity: 0.5, fontSize: '1.1rem', marginBottom: '40px' }}>E2EE Protocol Active</p>
        {!userProfile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><GoogleLogin onSuccess={handleLoginSuccess} theme="filled_black" shape="pill" size="large" /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}><div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }}></div><span style={{ fontSize: '0.7rem', opacity: 0.3, fontWeight: '800' }}>OR LOCAL GUEST</span><div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }}></div></div>
            <form onSubmit={handleGuestLogin} style={{ display: 'flex', gap: '10px' }}><input className="input-field" placeholder="Temporary Alias" value={guestName} onChange={e => setGuestName(e.target.value)} style={{ flex: 1 }} /><button className="btn-primary" type="submit">Start</button></form>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <button className="btn-primary" style={{ height: '60px', fontSize: '1.1rem' }} onClick={() => handleJoinRoom(currentRoomId, roomCode)} disabled={!currentRoomId}>Resume Last Session</button>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn-primary" style={{ flex: 1 }} onClick={() => { localStorage.removeItem('currentRoomId'); localStorage.removeItem('roomCode'); setShowCreateModal('create'); }}>Create New</button>
              <button className="btn-primary" style={{ flex: 1, background: 'rgba(255,255,255,0.05)', boxShadow: 'none', border: '1px solid var(--glass-border)' }} onClick={() => { localStorage.removeItem('currentRoomId'); localStorage.removeItem('roomCode'); setShowCreateModal('join'); }}>Join Existing</button>
            </div>
          </div>
        )}
      </div>
      {showCreateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(12px)' }}>
          <div className="glass-container animate-fade-in" style={{ padding: '45px', width: '420px' }}><h2 style={{ fontSize: '2rem', fontWeight: '800', textAlign: 'center', marginBottom: '30px' }}>{showCreateModal === 'join' ? 'Secure Entry' : 'Channel Birth'}</h2><form onSubmit={showCreateModal === 'join' ? (e) => { e.preventDefault(); handleJoinRoom(currentRoomId, roomCode); } : handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}><input className="input-field" placeholder="Mesh ID (Required)" value={currentRoomId} onChange={e => setCurrentRoomId(e.target.value.toUpperCase())} required />{showCreateModal === 'create' && <input className="input-field" placeholder="Label (e.g. Sales Team)" value={roomName} onChange={e => setRoomName(e.target.value)} required />}<input className="input-field" placeholder="Secret Key (E2EE Seed)" type="password" value={roomCode} onChange={e => setRoomCode(e.target.value)} required /><div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}><button className="btn-primary" type="submit" style={{ flex: 2 }}>{showCreateModal === 'join' ? 'Connect' : 'Initialize'}</button><button className="btn-primary" type="button" onClick={() => setShowCreateModal(false)} style={{ flex: 1, background: 'transparent', boxShadow: 'none', border: '1px solid var(--glass-border)' }}>Abort</button></div></form></div>
        </div>
      )}
    </div>
  );
}

export default App;
