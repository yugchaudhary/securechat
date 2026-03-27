import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { GoogleOAuthProvider } from '@react-oauth/google';
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <GoogleOAuthProvider clientId="644910483648-7vge2ptuu923vcged43o1p2942olklr0.apps.googleusercontent.com">
      <App />
    </GoogleOAuthProvider>
  </StrictMode >,
)
