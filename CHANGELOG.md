# Changelog

## 2.0.0 — 2026-11-19

A rewrite. The protocol is not compatible with 1.x: update all machines.

### Security

- **Messages are authenticated and encrypted with AES-256-GCM.** 1.x used AES-CTR without a MAC.
  A man-in-the-middle could change text (for example `ls -la` into `rm -rf`) without the passphrase.
  Any machine on the network could also forge clipboard text and terminal escape sequences:
  it only had to take the keystream from the HELLO message, whose plaintext is known.
- **Mutual passphrase check before any data.** 1.x sent HELLO and every clipboard change to any
  machine that connected. That also gave material for offline passphrase guessing.
- **Strong key derivation:** scrypt (128 MiB) once per connection.
  1.x ran PBKDF2 with 10,000 iterations for every message, on the main thread.
- **Forward secrecy and replay protection:** ephemeral X25519 keys and per-direction message counters.
- **Online guessing is slowed down:** after a wrong passphrase, the hub blocks the IP address
  (1 s, then doubling up to 60 s).
- Peer-supplied names are cleaned of control characters before they are printed.

### Fixed

- **Any 4 bytes (`NetP`) from the network crashed the server or the client.** A crafted header did the same.
- **Text larger than one TCP segment arrived corrupted, or was lost.** The receiver assumed that every
  `data` event starts with a whole fragment. On Wi-Fi/Ethernet a 3,000-character text arrived as 1,822
  characters of garbage. The integrity check passed it, so the garbage went into the clipboard.
- **The client crashed on its first reconnect attempt:** `setTimeout(createConnection)` passed no host or port.
- **Leading and trailing whitespace was removed** from received text (`trim()`): indentation and final newlines were lost.
- **Texts above ~130 KB (~65,000 Cyrillic characters) were never sent:** the part counter was one byte.
- **Copies were lost or echoed back** because of the 2-second "ignore" window. A copy made within 2 s after a
  received one was never sent. Two copies about 2 s apart were echoed back and could overwrite a newer copy.
  One failed clipboard write blocked all later copies.
- **Every connection started another clipboard poller that never stopped.** After N reconnects, `pbpaste` ran N
  times per second, and copies went to dead sockets with an "Ok." message.
- **The hub did not relay** text from one client to the other clients.
- **All clients shared one message assembler**, so fragments of different clients could mix.
- **The HELLO message was never processed** (it had no framing), so passphrase or version mismatches were not detected.
- **Passphrase input:**
  - Backspace added a `\x7f` character, and arrow keys added the text `undefined`. A typo made the
    passphrases on the two machines different, without an error message.
  - Input from a pipe never finished.
  - An empty passphrase was accepted.
- **Dead connections were not detected** after sleep or a network change; copies were lost with an "Ok." message.
- **Command line:**
  - A port that was not a number silently became 8134.
  - `--no-clipboard` before the host was taken as the host name.
  - Arguments were checked only after the passphrase prompt.
  - A busy port ended the program with exit code 0.
- On Linux under Wayland, clipboardy 4 used only `xsel` through XWayland.
- Unknown messages were printed in full, including clipboard text.

### New

- One command: `netpaste serve`, `netpaste connect [HOST[:PORT]]`, `netpaste discover`.
- Hub for many machines; `--no-clipboard` on the hub makes it a relay.
- mDNS discovery: `netpaste connect` without an address finds the hub.
- Passphrase from `--passphrase-file` or `NETPASTE_PASSPHRASE`, for autostart. Templates for launchd and systemd.
- Heartbeats, idle timeout, TCP keepalive, reconnect with exponential backoff and jitter.
- `--max-size` (default 10 MB), `--interval`, `--host`, `--no-mdns`, `--verbose`.
- The clipboard is read only while a peer is connected.
- Clear messages for a wrong passphrase, an old protocol version, a busy port, and a missing terminal.

### Internal

- TypeScript (strict), run directly by Node.js 22.18+ without a build step.
- `chalk` replaced by `util.styleText`; argument parsing with `util.parseArgs`; clipboardy 5 (native Wayland support).
- Tests with `node:test`: framing at every split point, crypto, handshake (including a man-in-the-middle),
  clipboard races, passphrase input, CLI, and end-to-end hub tests. CI on Linux and macOS, Node.js 22/24/26.
