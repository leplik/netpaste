/**
 * @fileoverview Decrypts and handles messages received from the server.
 * 
 * @name messageHandler.js
 * @author Aliaksei Smirnou
 */

import { decrypt } from './encryption.js';
import chalk from 'chalk';
import clipboardy from 'clipboardy';
import { setClipboardUpdateSource } from './monitorClipboard.js';

function logReceived(content) {
    const currentTime = new Date().toLocaleTimeString();
    process.stdout.write(`${chalk.gray(`[${currentTime}]`)} ${chalk.blue('Received content: ')}${chalk.green(content.length.toString())} characters.\n`);
}

export function handleMessage(data, passphrase, disableClipboard = false) {
        try {
        const decryptedMessage = decrypt(data.toString(), passphrase);
        if (decryptedMessage.startsWith('NETPASTE_HELLO:')) {
            const clientMessage = decryptedMessage.replace('NETPASTE_HELLO:', '').trim();
            console.log(`Peer message: ${clientMessage}`);
        } else if (decryptedMessage.startsWith('NETPASTE_UPDATE:')) {
            const updateMessage = decryptedMessage.replace('NETPASTE_UPDATE:', '').trim();            
            logReceived(updateMessage)
            if (!disableClipboard) {
                setClipboardUpdateSource(true);
                clipboardy.writeSync(updateMessage);
                
                setTimeout(() => {
                    setClipboardUpdateSource(false);
                }, 2000);
            }
        } else {
            console.log('Decrypted:', decryptedMessage);
        }
    } catch (error) {
        console.error('Decryption error', error);
    }
}
