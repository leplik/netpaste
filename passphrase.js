// passphraseHandler.js

import readline from 'readline';
import { Writable } from 'stream';

function getPassphrase(callback) {
    let mutableStdout = new Writable({
        write: function(chunk, encoding, callback) {
            if (!this.muted) process.stdout.write(chunk, encoding);
            callback();
        }
    });
    mutableStdout.muted = false;

    let passphrase = '';

    let rl = readline.createInterface({
        input: process.stdin,
        output: mutableStdout,
        terminal: true
    });

    process.stdout.write('Passphrase: ');
    mutableStdout.muted = true; // Mute the output to prevent displaying the password

    process.stdin.on('keypress', (char, key) => {
        if (key && key.name == 'return') {
            process.stdin.removeAllListeners('keypress');
            rl.close();
            mutableStdout.muted = false;
            console.log('\n'); // Move to the next line
            callback(passphrase); // Pass the captured passphrase to the callback
        } else if (key && key.ctrl && key.name == 'c') {
            process.exit(); // Allow exit on CTRL+C
        } else {
            passphrase += char;
            process.stdout.write("*");
        }
    });

    rl.question('', () => {}); // Empty question as we handle input manually
}

export { getPassphrase };