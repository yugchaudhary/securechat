// utils/crypto.js
/**
 * End-to-End Encryption Utilities using Web Crypto API (AES-GCM)
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derives a cryptographic key from a password (room code)
 */
export async function deriveKey(password, salt = 'static-salt-for-room') {
    const encSalt = encoder.encode(salt);
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encSalt,
            iterations: 100000,
            hash: 'SHA-256',
        },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypts a message string using a derived key
 */
export async function encryptMessage(message, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedMessage = encoder.encode(message);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encodedMessage
    );

    // Return as a base64 string including IV for transport
    const ivBase64 = btoa(String.fromCharCode(...iv));
    const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));

    return `${ivBase64}:${ciphertextBase64}`;
}

/**
 * Decrypts a base64 message string using a derived key
 */
export async function decryptMessage(encryptedBlob, key) {
    try {
        const [ivBase64, ciphertextBase64] = encryptedBlob.split(':');

        const iv = new Uint8Array(atob(ivBase64).split('').map(c => c.charCodeAt(0)));
        const ciphertext = new Uint8Array(atob(ciphertextBase64).split('').map(c => c.charCodeAt(0)));

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );

        return decoder.decode(decrypted);
    } catch (err) {
        console.error('Decryption failed:', err);
        return '[Encrypted Message - Key Mismatch]';
    }
}
