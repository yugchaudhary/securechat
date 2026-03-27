import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Shield, Send, Lock, User, Hash, MessageSquare, LogOut } from 'lucide-react';
import { deriveKey, encryptMessage, decryptMessage } from './utils/crypto';
import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const socket = io(SERVER_URL);

function App() {
  const [isJoined, setIsJoined] = useState(false);
  const [userProfile, setUserProfile] = useState(null); // stores { name, email, picture }
  const [guestName, setGuestName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [roomName, setRoomName] = useState(''); // for creating room
  const [myRooms, setMyRooms] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [currentRoomId, setCurrentRoomId] = useState('');
  const [messages, setMessages] = useState([]);
  const [activeUsers, setActiveUsers] = useState([]);
  const [membershipStatus, setMembershipStatus] = useState('none'); // 'none', 'pending', 'approved'
  const [currentMessage, setCurrentMessage] = useState('');
  const [encryptionKey, setEncryptionKey] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [burnTimer, setBurnTimer] = useState('none'); // 'none', '1m', '5m', '1h'
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [editingName, setEditingName] = useState('');

  const scrollRef = useRef();

  useEffect(() => {
    if (userProfile) {
      fetchRooms();
      fetchPendingRequests();
    }
  }, [userProfile]);

  const fetchRooms = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/${userProfile.email}`);
      const data = await res.json();
      setMyRooms(data);
    } catch (err) {
      console.error('Failed to fetch rooms');
    }
  };

  const fetchPendingRequests = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/pending/${userProfile.email}`);
      const data = await res.json();
      setPendingRequests(data);
    } catch (err) {
      console.error('Failed to fetch requests');
    }
  };

  useEffect(() => {
    socket.on('receive-message', async (data) => {
      if (encryptionKey) {
        if (data.type === 'reaction') {
          setMessages(prev => prev.map(m => m.id === data.targetMessageId ? { ...m, reactions: [...(m.reactions || []), data.message] } : m));
          return;
        }
        const decryptedContent = await decryptMessage(data.message, encryptionKey);
        setMessages((prev) => {
          // Prevent duplicates from same sender at same time
          const isDuplicate = prev.some(m => m.senderEmail === data.senderEmail && m.timestamp === data.timestamp && m.type === data.type);
          if (isDuplicate) {
            // Update the duplicate with the real ID from server
            return prev.map(m => m.senderEmail === data.senderEmail && m.timestamp === data.timestamp && m.type === data.type ? { ...m, id: data.id } : m);
          }
          return [...prev, { ...data, message: decryptedContent }];
        });
      }
    });

    socket.on('message-history', async (history) => {
      if (encryptionKey) {
        const decryptedHistory = await Promise.all(history.map(async (msg) => ({
          ...msg,
          sender: msg.sender_name,
          message: await decryptMessage(msg.encrypted_blob, encryptionKey)
        })));
        setMessages(decryptedHistory);
      }
    });

    socket.on('room-users', (users) => {
      setActiveUsers(users);
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
    };
  }, [encryptionKey, userProfile, currentRoomId, roomCode]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const interval = setInterval(() => {
      setMessages(prev => prev.filter(m => !m.expiresAt || new Date(m.expiresAt) > new Date()));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

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
      handleJoinRoom(roomId, roomCode);
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

  const updateRoomName = async () => {
    if (!editingName) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: currentRoomId, name: editingName, creatorEmail: userProfile.email })
      });
      if (res.ok) {
        fetchRooms();
        setShowRoomDetails(false);
      }
    } catch (err) {
      console.error('Failed to update room');
    }
  };

  const approveRequest = (roomId, userEmail) => {
    socket.emit('approve-request', { roomId, userEmail });
    setPendingRequests(prev => prev.filter(r => r.userEmail !== userEmail || r.roomId !== roomId));
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

  // 1. Logged in and Approved (Chat View)
  if (isJoined && membershipStatus === 'approved') {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
        {/* Sidebar */}
        <div className="glass-container" style={{ width: '280px', margin: '15px', display: 'flex', flexDirection: 'column', padding: '20px', gap: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="gradient-text" style={{ fontSize: '1.2rem' }}>SecureRooms</h2>
            <button onClick={() => setShowCreateModal('create')} style={{ background: 'var(--primary)', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
              <Hash size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {myRooms.map(room => (
              <div
                key={room.id}
                onClick={() => room.status === 'approved' && handleJoinRoom(room.id, roomCode)}
                style={{
                  padding: '12px',
                  borderRadius: '12px',
                  background: currentRoomId === room.id ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  transition: '0.2s',
                  opacity: room.status === 'approved' ? 1 : 0.5
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <p style={{ fontWeight: '600', fontSize: '0.9rem' }}>{room.name || 'Chat'}</p>
                  {room.status === 'pending' && <span style={{ fontSize: '0.6rem', background: '#f59e0b', padding: '2px 6px', borderRadius: '4px' }}>Pending</span>}
                </div>
                <p style={{ fontSize: '0.7rem', opacity: 0.6 }}>#{room.id}</p>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '20px' }}>
            <button onClick={handleLogout} className="btn-primary" style={{ width: '100%', background: 'rgba(255,44,44,0.1)', color: '#ff4444', border: '1px solid rgba(255,44,44,0.2)' }}>Logout</button>
          </div>
        </div>

        {/* Chat Area */}
        <div className="chat-window glass-container animate-fade-in" style={{ flex: 1, margin: '15px 15px 15px 0' }}>
          <div style={{ padding: '20px', borderBottom: '1px solid var(--glass-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ padding: '8px', background: 'rgba(6, 182, 212, 0.1)', borderRadius: '10px' }}>
                <MessageSquare color="#06b6d4" size={20} />
              </div>
              <div>
                <h3 style={{ fontSize: '1rem' }}>{myRooms.find(r => r.id === currentRoomId)?.name || 'Chat'}</h3>
                <span style={{ fontSize: '0.75rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ width: '6px', height: '6px', background: '#10b981', borderRadius: '50%' }}></div>
                  {activeUsers.length} Active • Secure E2EE
                </span>
              </div>
            </div>

            {/* Pending Requests Bubble */}
            {pendingRequests.length > 0 && (
              <div style={{ background: 'rgba(236, 72, 153, 0.1)', padding: '8px 12px', borderRadius: '12px', border: '1px solid var(--secondary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', fontWeight: '600' }}>{pendingRequests.length} Join Requests</p>
                <button
                  onClick={() => approveRequest(pendingRequests[0].room_id, pendingRequests[0].user_email)}
                  style={{ background: 'var(--secondary)', border: 'none', color: 'white', padding: '4px 8px', borderRadius: '6px', fontSize: '0.7rem', cursor: 'pointer' }}
                >
                  Approve {pendingRequests[0].user_email.split('@')[0]}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                onClick={() => {
                  const room = myRooms.find(r => r.id === currentRoomId);
                  setEditingName(room?.name || '');
                  setShowRoomDetails(true);
                }}
                className="btn-primary"
                style={{ padding: '8px 12px', fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)' }}
              >
                Room Info
              </button>
              <img src={userProfile.picture} alt={userProfile.name} style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
            </div>
          </div>

          <div className="messages-container" ref={scrollRef}>
            <AnimatePresence>
              {messages.map((msg, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className={`message ${msg.sender === userProfile.name ? 'sent' : 'received'}`}
                >
                  <div style={{ fontSize: '0.7rem', marginBottom: '4px', opacity: 0.7, fontWeight: '600' }}>
                    {msg.sender === userProfile.name ? 'You' : msg.sender}
                  </div>
                  <div>
                    {msg.type === 'image' ? (
                      <img src={msg.message} alt="Shared" style={{ maxWidth: '100%', borderRadius: '8px', marginTop: '5px' }} />
                    ) : (
                      msg.message
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '5px' }}>
                    <div style={{ display: 'flex', gap: '5px' }}>
                      <div className="message-meta">{msg.timestamp}</div>
                      <button onClick={() => addReaction(msg.id, '❤️')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.7rem', opacity: 0.5 }}>❤️</button>
                      <button onClick={() => addReaction(msg.id, '👍')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.7rem', opacity: 0.5 }}>👍</button>
                    </div>
                    {msg.expiresAt && <div style={{ fontSize: '0.6rem', color: '#f87171' }}>🔥 Auto-destruct @ {new Date(msg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
                  </div>
                  {msg.reactions && (
                    <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                      {msg.reactions.map((r, i) => <span key={i} style={{ fontSize: '0.8rem' }}>{r}</span>)}
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <form onSubmit={sendMessage} style={{ padding: '20px', display: 'flex', gap: '12px', borderTop: '1px solid var(--glass-border)', alignItems: 'center' }}>
            <label className="btn-primary" style={{ padding: '10px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)' }}>
              <Hash size={20} />
              <input type="file" onChange={handleFileUpload} accept="image/*" style={{ display: 'none' }} />
            </label>

            <select
              value={burnTimer}
              onChange={(e) => setBurnTimer(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '10px', fontSize: '0.8rem' }}
            >
              <option value="none">No Burn</option>
              <option value="1m">1 min</option>
              <option value="5m">5 mins</option>
              <option value="1h">1 hour</option>
            </select>

            <input
              className="input-field"
              placeholder="Type a secure message..."
              style={{ flex: 1 }}
              value={currentMessage}
              onChange={(e) => setCurrentMessage(e.target.value)}
            />
            <button className="btn-primary" type="submit" style={{ padding: '12px' }}>
              <Send size={20} />
            </button>
          </form>

          {/* Room Details Modal */}
          {showRoomDetails && (
            <div className="flex-center" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="glass-container" style={{ padding: '30px', width: '350px' }}>
                <h2 style={{ marginBottom: '20px' }}>Room Details</h2>
                <div style={{ spaceY: '15px' }}>
                  <div style={{ marginBottom: '15px' }}>
                    <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Room Name</p>
                    {userProfile.email === myRooms.find(r => r.id === currentRoomId)?.creator_email ? (
                      <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                        <input className="input-field" value={editingName} onChange={e => setEditingName(e.target.value)} />
                        <button onClick={updateRoomName} className="btn-primary">Save</button>
                      </div>
                    ) : (
                      <p style={{ fontWeight: '600' }}>{myRooms.find(r => r.id === currentRoomId)?.name}</p>
                    )}
                  </div>
                  <div style={{ marginBottom: '15px' }}>
                    <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Room ID</p>
                    <p style={{ fontWeight: '600' }}>#{currentRoomId}</p>
                  </div>
                  <div style={{ marginBottom: '15px' }}>
                    <p style={{ fontSize: '0.8rem', opacity: 0.6, display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <Lock size={12} /> Encryption Key (Room Code)
                    </p>
                    <p style={{ fontWeight: '600', color: 'var(--primary)' }}>{myRooms.find(r => r.id === currentRoomId)?.room_code || 'Hidden'}</p>
                  </div>
                  <button onClick={() => setShowRoomDetails(false)} className="btn-primary" style={{ width: '100%', marginTop: '10px' }}>Close</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 2. Logged in and Pending/None (Waiting Screen)
  if (isJoined) {
    return (
      <div className="flex-center" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-container animate-fade-in" style={{ padding: '40px', width: '450px', textAlign: 'center' }}>
          {membershipStatus === 'pending' ? <Shield size={48} color="#f59e0b" style={{ marginBottom: '20px', margin: '0 auto' }} /> : <MessageSquare size={48} color="#06b6d4" className="animate-pulse" style={{ marginBottom: '20px', margin: '0 auto' }} />}
          <h2 style={{ marginBottom: '10px' }}>{membershipStatus === 'pending' ? 'Waiting for Approval' : 'Connecting to Room...'}</h2>
          <p style={{ opacity: 0.7, fontSize: '0.9rem', marginBottom: '25px' }}>
            {membershipStatus === 'pending'
              ? `You have requested to join **${currentRoomId}**. The creator must approve you.`
              : `Entering secure channel **${currentRoomId}**...`
            }
          </p>
          <button className="btn-primary" onClick={() => setIsJoined(false)} style={{ background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)' }}>Go Back</button>
        </div>
      </div>
    );
  }

  // 3. Login Screen (Not Joined)
  return (
    <div className="flex-center" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="glass-container animate-fade-in" style={{ padding: '40px', width: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <div style={{ display: 'inline-flex', padding: '12px', background: 'rgba(99, 102, 241, 0.2)', borderRadius: '16px', marginBottom: '16px' }}>
            <Shield size={32} color="#6366f1" />
          </div>
          <h1 className="gradient-text" style={{ fontSize: '2rem', marginBottom: '8px' }}>SecureChat</h1>
          <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>End-to-End Encrypted Messaging</p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {!userProfile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <GoogleLogin
                  onSuccess={handleLoginSuccess}
                  onError={() => console.log('Login Failed')}
                  theme="filled_blue"
                  shape="pill"
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', opacity: 0.4 }}>
                <div style={{ flex: 1, height: '1px', background: 'white' }}></div>
                <span style={{ fontSize: '0.7rem' }}>OR</span>
                <div style={{ flex: 1, height: '1px', background: 'white' }}></div>
              </div>

              <form onSubmit={handleGuestLogin} style={{ display: 'flex', gap: '10px' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <User size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                  <input
                    className="input-field"
                    placeholder="Guest Username"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    style={{ width: '100%', paddingLeft: '35px', fontSize: '0.85rem' }}
                  />
                </div>
                <button className="btn-primary" type="submit" style={{ padding: '8px 15px', fontSize: '0.85rem' }}>Guest</button>
              </form>
            </div>
          ) : (
            <div className="animate-fade-in" style={{ padding: '15px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '15px', border: '1px solid var(--glass-border)' }}>
              <img src={userProfile.picture} alt={userProfile.name} style={{ width: '40px', height: '40px', borderRadius: '50%' }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: '600', fontSize: '0.9rem' }}>{userProfile.name}</p>
                <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>{userProfile.email}</p>
              </div>
              <button onClick={() => setUserProfile(null)} style={{ background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer', padding: '5px' }}>
                <LogOut size={16} />
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-primary" style={{ flex: 1 }} onClick={() => { setShowCreateModal('create'); setCurrentRoomId(''); }} disabled={!userProfile}>Create Room</button>
            <button className="btn-primary" style={{ flex: 1, background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)' }} onClick={() => { setShowCreateModal('join'); setCurrentRoomId(''); }} disabled={!userProfile}>Join Room</button>
          </div>

          {/* Recently Joined List */}
          {userProfile && myRooms.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <p style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '10px', opacity: 0.6 }}>Your Active Rooms</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {myRooms.map(room => (
                  <button
                    key={room.id}
                    onClick={() => {
                      setCurrentRoomId(room.id);
                      setShowCreateModal('join');
                    }}
                    className="glass-container"
                    style={{ textAlign: 'left', padding: '10px', fontSize: '0.85rem', width: '100%', border: '1px solid var(--glass-border)', cursor: 'pointer' }}
                  >
                    {room.name || 'Chat'} (#{room.id})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: '30px', padding: '12px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '12px', fontSize: '0.8rem', display: 'flex', gap: '10px' }}>
          <Lock size={16} />
          <span>Messages are end-to-end encrypted and never stored in plain text.</span>
        </div>
      </div>

      {/* Create/Join Modal */}
      {showCreateModal && (
        <div className="flex-center" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-container animate-fade-in" style={{ padding: '30px', width: '350px' }}>
            <h2 style={{ marginBottom: '20px' }}>{showCreateModal === 'join' ? 'Join Room' : 'Create New Room'}</h2>
            <form onSubmit={showCreateModal === 'join' ? (e) => { e.preventDefault(); handleJoinRoom(currentRoomId, roomCode); } : handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              {showCreateModal !== 'join' && (
                <input className="input-field" placeholder="Room Name" value={roomName} onChange={e => setRoomName(e.target.value)} required />
              )}
              <input className="input-field" placeholder="Room ID (e.g. #ABCDEF)" value={currentRoomId} onChange={e => setCurrentRoomId(e.target.value.toUpperCase())} required />
              <input className="input-field" placeholder="Encryption Key (Room Code)" type="password" value={roomCode} onChange={e => setRoomCode(e.target.value)} required />
              <button className="btn-primary" type="submit">{showCreateModal === 'join' ? 'Join' : 'Create'}</button>
              <button className="btn-primary" type="button" onClick={() => { setShowCreateModal(false); setCurrentRoomId(''); }} style={{ background: 'transparent', border: '1px solid var(--glass-border)' }}>Cancel</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
