/**
 * @fileoverview Sends an update to the server.
 * 
 * @name sendUpdate.js
 * @author Aliaksei Smirnou
 */

import { encrypt } from './encryption.js';
import { fragmentAndSendMessage } from './fragmenter.js';

export async function sendUpdate(client, message, passphrase) {
    if (!client) {
        console.log('No connection to server. Attempting to reconnect...');
        return;
    }

    const encryptedMessage = encrypt('NETPASTE_UPDATE:' + message, passphrase);
    fragmentAndSendMessage(encryptedMessage, client);
}