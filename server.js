// Path: server.js

import net from 'net';
import { getPassphrase } from './passphrase.js';
import { handleMessage } from './messageHandler.js';
import { encrypt } from './encryption.js';
import { monitorClipboard } from './monitorClipboard.js';
import { sendUpdate } from './sendUpdate.js';
import { DEFAULT_PORT } from './config.js';

let passphrase = '';

function startServer(port) {
    const server = net.createServer((socket) => {
        console.log('Client connection attempt.');

        const message = 'NETPASTE_HELLO:Netpaste server v1.0';
        const encryptedMessage = encrypt(message, passphrase);
        socket.write(encryptedMessage);

        monitorClipboard(sendUpdate.bind(null, socket), passphrase).catch(console.error);

        socket.on('data', (data) => {
            handleMessage(data, passphrase);
        });

        socket.on('end', () => {
            console.log('Client disconnected');
        });

        socket.on('error', (err) => {
            console.error('Socket error:', err.message);
        });
    });

    server.on('error', (err) => {
        console.error('Server error:', err.message);
    });

    server.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}

function parseCommandLineArgs() {
    const port = parseInt(process.argv[2], 10) || DEFAULT_PORT;
    if (port < 0 || port > 65535 || isNaN(port)) {
        console.error('Invalid command-line argument. Usage: node server.js [port]');
        console.log('Using default port:', DEFAULT_PORT);
        process.exit(1);
    }
    return port;
}

getPassphrase((input) => {
    passphrase = input;
    const port = parseCommandLineArgs();
    startServer(port);
});
