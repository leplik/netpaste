/**
 * @fileoverview Monitors the clipboard for changes and sends updates to the server.
 * 
 * @name monitorClipboard.js
 * @author Aliaksei Smirnou
 */

import chalk from 'chalk';
import clipboardy from 'clipboardy';

async function readClipboard() {
    try {
        return await clipboardy.read();
    } catch (error) {
        console.error(chalk.red(`Failed to read clipboard: ${error.message}`));
        return null;
    }
}

function logSending(content) {
    const currentTime = new Date().toLocaleTimeString();
    process.stdout.write(`${chalk.gray(`[${currentTime}]`)} ${chalk.blue('Sending content: ')}${chalk.yellow(content.length.toString())} characters...`);
}

function logResult(result) {
    process.stdout.write(result ? chalk.green(' Ok.\n') : chalk.red(' Error.\n'));
}

export async function monitorClipboard(sendUpdate, passphrase) {
    let lastClipboardContent = await readClipboard();

    setInterval(async () => {
        const content = await readClipboard();

        if (content && content !== lastClipboardContent) {
            logSending(content);
            lastClipboardContent = content;
            try {
                await sendUpdate(content, passphrase);
                logResult(true);
            } catch (error) {
                console.error(chalk.red(`Error sending update: ${error.message}`));
                logResult(false);
            }
        }
    }, 1000);
}
