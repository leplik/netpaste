# netpaste

Encrypted clipboard sync between your machines on a local network.
Copy on one machine, paste on another. Works on macOS and Linux (X11 and Wayland).

- **Encrypted and authenticated.** Each machine proves that it knows the shared passphrase.
  Messages use AES-256-GCM with new keys for every connection (X25519 + scrypt + HKDF).
  A machine that has not proved the passphrase receives nothing.
- **One hub, many machines.** One machine runs `netpaste serve`, the others run `netpaste connect`.
  The hub relays text between all clients. A headless machine can be a pure relay (`--no-clipboard`).
- **Finds the hub by itself.** `netpaste connect` without an address looks for the hub on the local network (mDNS).
- **Stays connected.** Heartbeats detect dead connections (laptop sleep, Wi-Fi change).
  The client reconnects automatically.
- **Exact text.** Spaces, line endings and Unicode arrive unchanged. Up to 10 MB per copy (configurable).
- **No cloud, no account.** The traffic stays on your network.

## Requirements

- Node.js 22.18 or newer. netpaste runs its TypeScript sources directly, without a build step.
- macOS: nothing else.
- Linux: `wl-clipboard` on Wayland, or `xsel` on X11 (a bundled `xsel` is used when it is missing).

## Install

```bash
git clone https://github.com/leplik/netpaste.git
cd netpaste
npm install
npm install -g .   # adds the `netpaste` command (a link to this folder)
```

Without the global install, use `node bin/netpaste.js` instead of `netpaste`.

## Use

Use the same passphrase on all machines. Make it long: 4 or more random words, or 12+ characters.

```bash
# On the hub (any machine that stays on):
netpaste serve

# On every other machine:
netpaste connect                 # finds the hub on the local network
netpaste connect 192.168.1.10    # or give the address (HOST or HOST:PORT)
```

```text
$ netpaste connect
Passphrase: ****************************
14:02:11 netpaste 2.0.0; clipboard sync is on
14:02:14 found server "studio" at 192.168.1.10:8134
14:02:14 connected to studio (192.168.1.10:8134)
14:02:31 → 1,204 chars sent to studio (192.168.1.10:8134)
14:03:05 ← 87 chars from studio (192.168.1.10:8134)
```

netpaste prints only the size of the text, never the text.
Copies are sent only while a connection is open; a copy made while disconnected is not sent later.

### Commands and options

| Command | What it does |
|---|---|
| `netpaste serve` | Start the hub. Listens on port 8134 and announces itself with mDNS. |
| `netpaste connect [HOST[:PORT]]` | Connect to the hub. Without HOST it finds the hub with mDNS. |
| `netpaste discover` | List the hubs on the local network. |

| Option | Default | Meaning |
|---|---|---|
| `-p, --port N` | 8134 | TCP port. |
| `--host ADDR` | all interfaces | `serve`: listen only on this address (the hub is then not announced with mDNS). |
| `--no-clipboard` | | Do not use the local clipboard. With `serve`: only relay between clients. |
| `--no-mdns` | | `serve`: do not announce the hub on the network. |
| `--passphrase-file F` | | Read the passphrase from file F. |
| `--interval MS` | 1000 | How often to check the clipboard. |
| `--max-size SIZE` | 10mb | Largest text to send or accept, from `1kb` to `64mb`. |
| `--timeout SEC` | 3 | `discover`: how long to search. |
| `--verbose` | | Show debug messages. |

### Passphrase without a prompt

netpaste takes the passphrase from the first source that is set:

1. `--passphrase-file FILE`: the content of the file (one final newline is removed);
2. the `NETPASTE_PASSPHRASE` environment variable;
3. a prompt on the terminal.

```bash
mkdir -p ~/.config/netpaste
touch ~/.config/netpaste/passphrase && chmod 600 ~/.config/netpaste/passphrase
nano ~/.config/netpaste/passphrase   # type the passphrase and save
netpaste connect --passphrase-file ~/.config/netpaste/passphrase
```

netpaste warns when other users can read the file.

### Firewall

- **macOS:** when macOS asks whether `node` may accept incoming connections, allow it (only on the hub).
- **Linux:** open TCP 8134 on the hub, and UDP 5353 for mDNS, for example `sudo ufw allow 8134/tcp && sudo ufw allow 5353/udp`.

## Start automatically

Both templates run `netpaste connect` (find the hub with mDNS) with a passphrase file.
For the hub, replace `connect` with `serve`. To connect to a fixed address, add it after `connect`.

### macOS (launchd)

```bash
cd netpaste
sed -e "s|__NODE__|$(command -v node)|" -e "s|__NETPASTE__|$PWD/bin/netpaste.js|" -e "s|__HOME__|$HOME|g" \
  contrib/launchd/io.github.leplik.netpaste.plist > ~/Library/LaunchAgents/io.github.leplik.netpaste.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.leplik.netpaste.plist
tail -f ~/Library/Logs/netpaste.log
```

Stop: `launchctl bootout gui/$(id -u)/io.github.leplik.netpaste`.
The template contains the full path to `node`. If you change the Node.js version (for example with nvm), install the template again.

Tip: to keep the passphrase in the Keychain instead of a file, store it with
`security add-generic-password -a "$USER" -s netpaste -w` and start netpaste through
`/bin/sh -c 'NETPASTE_PASSPHRASE="$(security find-generic-password -s netpaste -w)" exec …'`.

### Linux (systemd user service)

```bash
cd netpaste
mkdir -p ~/.config/systemd/user
sed -e "s|__NODE__|$(command -v node)|" -e "s|__NETPASTE__|$PWD/bin/netpaste.js|" \
  contrib/systemd/netpaste.service > ~/.config/systemd/user/netpaste.service
systemctl --user daemon-reload
systemctl --user enable --now netpaste.service
journalctl --user -u netpaste -f
```

The service starts with the graphical session, because it needs the display for the clipboard.
If netpaste cannot read the clipboard, run
`systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY` and restart the service.
For a headless relay hub, use `serve --no-clipboard`, change `WantedBy=` to `default.target`,
and run `loginctl enable-linger $USER` so that the service runs without a login.

## Security

The full design is in [docs/PROTOCOL.md](docs/PROTOCOL.md). In short:

**Protects against:**

- eavesdroppers: they cannot read the text, and they cannot test passphrase guesses;
- changed, replayed or reordered messages: they fail authentication and close the connection;
- strangers who connect to the hub: they receive nothing until they prove the passphrase.
  The hub limits their connections (4 per address, 32 in total) and runs scrypt only for a real passphrase attempt.
  After a wrong passphrase, the hub blocks that address (IPv6: the /64) for 1 s, then 2 s, 4 s … up to 60 s;
- malformed input and floods: they close that one connection, never the program.

**Does not protect against:**

- **a weak passphrase.** An attacker who pretends to be the hub (a fake mDNS announcement or a
  man-in-the-middle) can try passphrase guesses offline. Each guess costs one scrypt run (128 MiB, about
  0.2 s), so a long random passphrase makes this impractical, and a short one does not;
- text sizes: the size of each copy is visible on the network;
- machines that know the passphrase: they can read your copies and write to your clipboard;
- password managers: netpaste syncs a copied password like any other text, and the other
  machine keeps it after the password manager clears its own clipboard.

**Known limitation:** if you copy on two machines within about a second, the copies can cross:
each machine keeps the other's text until the next copy. See [docs/PROTOCOL.md](docs/PROTOCOL.md#known-limitations).

## Upgrading from 1.x

Version 2 uses a new protocol. It cannot talk to 1.x, so update all machines.

| 1.x | 2.x |
|---|---|
| `node server.js [port]` | `netpaste serve [--port N]` |
| `node client.js HOST [port]` | `netpaste connect HOST[:PORT]` |
| `--no-clipboard` | `--no-clipboard` (on the hub it now means "relay only") |

The list of fixed problems is in [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # node:test: unit, protocol, security and end-to-end tests
node bin/netpaste.js serve --no-clipboard --verbose
```

The tests never touch the real clipboard: they use an in-memory clipboard.
The mDNS test uses multicast on the loopback interface only.

## Author

Aliaksei Smirnou. MIT License.
