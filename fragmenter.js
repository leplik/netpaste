// fragmenter.js

import { MAX_FRAGMENT_SIZE } from './config.js';

export function fragmentAndSendMessage(message, client) {
    const messageBuffer = Buffer.from(message);
    const totalParts = Math.ceil(messageBuffer.length / MAX_FRAGMENT_SIZE);
    const uid = Date.now();
    const magicNumber = Buffer.from([0x4E, 0x65, 0x74, 0x50]); // 'NetP' in hex

    for (let part = 0; part < totalParts; part++) {
        const start = part * MAX_FRAGMENT_SIZE;
        const end = start + MAX_FRAGMENT_SIZE;
        const fragment = messageBuffer.slice(start, end);

        const header = Buffer.alloc(20); // Adjust based on UID size
        header.writeBigInt64BE(BigInt(uid), 0); // UID
        header.writeUInt8(part + 1, 8); // Part number
        header.writeUInt8(totalParts, 9); // Total parts

        const packet = Buffer.concat([magicNumber, header, fragment]);
        client.write(packet);
    }
}

class MessageAssembler {
    constructor() {
        this.messages = {};
        this.magicNumber = Buffer.from([0x4E, 0x65, 0x74, 0x50]); // 'NetP'
    }

    addData(data, callback) {
        let start = 0;
        let nextMagicNumberIndex = data.indexOf(this.magicNumber, start);

        while (nextMagicNumberIndex !== -1) {
            // Move past the magic number for the start of the actual data
            const fragmentStart = nextMagicNumberIndex + this.magicNumber.length;

            // Find the next occurrence of the magic number
            const nextStart = data.indexOf(this.magicNumber, fragmentStart);

            let fragment;
            if (nextStart === -1) {
                // If there's no other magic number, slice from the current start to the end of data
                fragment = data.slice(fragmentStart);
            } else {
                // Slice the data from the current start to the next magic number
                fragment = data.slice(fragmentStart, nextStart);
            }

            // Now that the fragment is correctly sliced (without the magic number), process it
            this.addFragment(fragment, callback);

            if (nextStart === -1) {
                break; // Exit if there are no more fragments
            } else {
                // Prepare to search for the next fragment
                nextMagicNumberIndex = nextStart;
            }
        }
    }
    addFragment(data, callback) {
        // Extract the header info
        const uid = data.readBigInt64BE(0);
        const part = data.readUInt8(8);
        const totalParts = data.readUInt8(9);
        const fragment = data.slice(20); // Assuming the header is 20 bytes
        
        // If this is the first fragment received for a message, initialize storage
        if (!this.messages[uid]) {
            this.messages[uid] = { parts: new Array(totalParts), received: 0 };
        }

        // Store the fragment
        if (!this.messages[uid].parts[part - 1]) { // Prevent overriding in case of duplicate fragments
            this.messages[uid].parts[part - 1] = fragment;
            this.messages[uid].received++;

            // Check if all parts have been received
            if (this.messages[uid].received === totalParts) {
                // Sort the parts
                const completeMessage = Buffer.concat(this.messages[uid].parts);
                delete this.messages[uid]; // Remove stored parts to free memory

                // Invoke the callback with the complete message
                if (typeof callback === 'function') {
                    callback(completeMessage);
                }
            }
        }

        // Return null if the message is not yet fully assembled
        return null;
    }
}

export default MessageAssembler;
