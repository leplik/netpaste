/**
 * @fileoverview Server entry point
 * 
 * @name server.js
 * @author Aliaksei Smirnou
 */

import net from 'net';
import { getPassphrase } from './passphrase.js';
import { handleMessage } from './messageHandler.js';
import { encrypt } from './encryption.js';
import { monitorClipboard } from './monitorClipboard.js';
import { sendUpdate } from './sendUpdate.js';
import { DEFAULT_PORT } from './config.js';
import MessageAssembler from './fragmenter.js';
const messageAssembler = new MessageAssembler();

let passphrase = '';

function startServer(port, disableClipboard) {
    const server = net.createServer((socket) => {
        console.log('Client connection attempt.');

        const message = 'NETPASTE_HELLO:Netpaste server v1.0';
        const encryptedMessage = encrypt(message, passphrase);
        socket.write(encryptedMessage);

        if (!disableClipboard) {
            monitorClipboard(sendUpdate.bind(null, socket), passphrase).catch(console.error);
        }

        socket.on('data', (data) => {
            // Use the addData method with a callback to handle the complete message.
            messageAssembler.addData(data, (completeMessage) => {
                handleMessage(completeMessage, passphrase, disableClipboard);
            });
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
    const args = process.argv.slice(2); // Slice to remove the node and script paths
    const portArg = args.find(arg => !isNaN(parseInt(arg, 10)));
    const disableClipboard = args.includes('--no-clipboard');

    const port = parseInt(portArg, 10) || DEFAULT_PORT;
    if (portArg && (port < 0 || port > 65535 || isNaN(port))) {
        console.error('Invalid port number. Usage: node server.js [port] [--no-clipboard]');
        process.exit(1);
    }

    return { port, disableClipboard };
}

getPassphrase((input) => {
    passphrase = input;
    const { port, disableClipboard } = parseCommandLineArgs();
    startServer(port, disableClipboard);
});
