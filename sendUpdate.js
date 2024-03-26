// sendUpdate.js

import { encrypt } from './encryption.js';

export async function sendUpdate(client, message, passphrase) {
    if (!client) {
        console.log('No connection to server. Attempting to reconnect...');
        return;
    }

    const encryptedMessage = encrypt('NETPASTE_UPDATE:' + message, passphrase);
    client.write(encryptedMessage);
}
