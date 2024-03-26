# netpaste

Netpaste is a utility crafted for developers who frequently work across Linux and macOS environments, providing a seamless method to share clipboard data between machines. Created out of necessity by a full-stack developer tired of the lack of simple tools for this task, **netpaste** offers an efficient, peer-to-peer clipboard sharing solution that's both secure and easy to use.

## Features

- **Encryption:** All data shared between clients is encrypted.
- **Peer-to-Peer (P2P):** Directly shares clipboard data between machines.
- **Automatic Clipboard Monitoring:** Actively monitors your clipboard for changes.

## Installation

Before you dive into using Netpaste, there are a few prerequisites and steps to follow:

### Dependencies

- Node.js and npm (Node Package Manager)

### Steps

1. Clone the Netpaste repository to your local machine.
```bash
git clone https://github.com/leplik/netpaste.git; 
```
2. Navigate into the Netpaste directory and run `npm install` to install the required Node.js dependencies.
```bash
cd netpaste
npm install
```
3. Allow Netpaste server through your firewall to ensure it can communicate over the network. This process varies by operating system:
   - **Linux:** Use UFW or your distro's firewall settings to allow traffic on the default port (8134): `sudo ufw allow 8134`
   - **macOS:** Go to `System Preferences > Security & Privacy > Firewall`, and add an exception for Netpaste.

## Usage

Netpaste is comprised of two parts: the server and the client. Each machine should run its instance of the utility.

### Server

Start the server on the machine that will be... server (no matters for copy-pasting process):

```bash
node server.js [port]
```
If no port is specified, Netpaste uses the default port 8134.

### Client
On other machine start the client:

```bash
node client.js <hostname> [port]
```
`<hostname>`: The IP address or hostname of the server.
`[port]`: The port number (optional, defaults to 8134 if not provided).

### Supported Platforms
Netpaste is tested and supported on Linux and macOS platforms. It leverages platform-independent technologies but adheres closely to Unix-like operating system behaviors.

### Author
Aliaksei Smirnou