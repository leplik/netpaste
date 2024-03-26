/**
 * @fileoverview This module provides encryption and decryption functions for the Netpaste application.
 * 
 * @name encryption.js
 * @author Aliaksei Smirnou
 */

import crypto from 'crypto';

// Cryptographic configuration
const config = {
    algorithm: 'aes-256-ctr',
    messageFlag: 'NETPASTE_FLAG',
    saltLength: 16,
    ivLength: 16,
    keyLength: 32,
    hashFunction: 'sha512',
    iterations: 10000
};

function encrypt(text, passphrase) {
    const salt = crypto.randomBytes(config.saltLength);
    const iv = crypto.randomBytes(config.ivLength);
    const key = crypto.pbkdf2Sync(passphrase, salt, config.iterations, config.keyLength, config.hashFunction);
    const cipher = crypto.createCipheriv(config.algorithm, key, iv);
    const textWithFlag = `${config.messageFlag}:${text}`;
    const encrypted = Buffer.concat([cipher.update(textWithFlag, 'utf8'), cipher.final()]);
    return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(data, passphrase) {
    const [saltHex, ivHex, encryptedHex] = data.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.pbkdf2Sync(passphrase, salt, config.iterations, config.keyLength, config.hashFunction);
    const decipher = crypto.createDecipheriv(config.algorithm, key, iv);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
    return verifyMessage(decrypted.toString());
}

function verifyMessage(data) {
    if (!data.startsWith(config.messageFlag)) {
        throw new Error('Integrity check failed. Verify your passphrase.');
    }
    // Remove the flag from the decrypted text
    return data.substring(config.messageFlag.length + 1);
}

export { encrypt, decrypt };