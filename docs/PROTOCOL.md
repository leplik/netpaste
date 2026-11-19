# netpaste protocol, version 2

This document describes the wire protocol and the security design of netpaste 2.
Version 1 (netpaste 1.x) is not compatible.

## Overview

```
client                                                     hub
  │── TCP connect ─────────────────────────────────────────▶│
  │── HELLO  "NETPASTE" | 2 | role=0 | X25519 key eC ───────▶│
  │◀── HELLO "NETPASTE" | 2 | role=1 | X25519 key eS ────────│
  │   client: transcript, scrypt, X25519, HKDF (see below)   │
  │── AUTH   client proof ─────────────────────────────────▶│  hub: scrypt only now, then check
  │◀── AUTH  hub proof ──────────────────────────────────────│  wrong → block the address,
  │                                                           │          wait 1 s, ERROR, close
  │══ SEALED INFO ═══════════════════════════════════════════│  both directions
  │══ SEALED CLIP / PING / PONG ══════════════════════════════│
```

## Framing

TCP is a byte stream, so every message is a frame:

```
length (u32, big-endian; counts type + body) | type (u8) | body
```

| Type | Name | When | Body |
|---|---|---|---|
| `0x01` | HELLO | handshake | 42 bytes, see below |
| `0x02` | AUTH | handshake | 32-byte proof |
| `0x03` | ERROR | handshake | 1-byte code: 1 wrong passphrase, 2 other version, 3 protocol error |
| `0x10` | SEALED | after the handshake | AES-256-GCM ciphertext + 16-byte tag |

The receiver checks the length before it buffers the body:

- before authentication, the largest body is 256 bytes;
- after authentication, the largest body is the text limit (`--max-size`, at least 4 KiB) + 17 bytes.

A frame above the limit, an unknown frame type during the handshake, or a failed decryption
closes the connection.

The receiver also stops reading from the socket when more than one maximum-size frame + 64 KiB
waits unread, for example while the hub runs scrypt. TCP flow control then stops the sender,
so a peer cannot make the receiver buffer more than that.

## Handshake

`HELLO` body: `"NETPASTE"` (8 bytes) | protocol version (u8, = 2) | role (u8: 0 client, 1 hub) | ephemeral X25519 public key (32 bytes).

Both sides compute:

```
transcript = SHA-256("netpaste/2 transcript" | helloClient | helloHub)
salt       = SHA-256("netpaste/2 kdf salt" | transcript)
pk         = scrypt(NFC(passphrase), salt, N = 2^17, r = 8, p = 1, 32 bytes)
dh         = X25519(own ephemeral private key, peer ephemeral public key)   (all-zero result is rejected)
keys       = HKDF-SHA256(ikm = dh | pk, salt = transcript, info = "netpaste/2 session keys", 128 bytes)
           = clientToHub | hubToClient | clientProofKey | hubProofKey
```

- The client sends `AUTH = HMAC-SHA256(clientProofKey, "netpaste/2 client proof" | transcript)`.
- The hub waits for this AUTH **before** it runs scrypt. So every scrypt run on the hub belongs to a
  passphrase attempt, and a stranger who sends only HELLO costs the hub nothing.
- The hub checks the client proof with a constant-time comparison.
  - **Wrong proof:** the hub blocks the address at once (see below), waits 1 s, sends `ERROR 1`, and closes the connection.
    It also closes the other unauthenticated connections from that address.
  - **Correct proof:** the hub sends `AUTH = HMAC-SHA256(hubProofKey, "netpaste/2 server proof" | transcript)`.
- The client checks the hub proof. If it is wrong, the client closes the connection and tries again later.

ERROR frames are not authenticated. The client believes `ERROR 1` (wrong passphrase) only after it sent its AUTH.
It stops with an error only when the user gave the hub address; for a hub found with mDNS it keeps trying.

The passphrase is normalized to Unicode NFC, so the same passphrase typed on macOS and on Linux gives the same key.
The whole handshake must finish within 10 s.

Limits on the hub, so that strangers cannot block real clients:

| Limit | Value |
|---|---|
| Connections without the passphrase, from one address (IPv6: one /64) | 4 |
| Connections without the passphrase, in total | 32 |
| Authenticated peers | 32 |
| Parallel scrypt runs (128 MiB each) | 2 |
| Block after a wrong passphrase (per address, IPv6 per /64) | 1 s, doubling with every failure, up to 60 s |

A blocked address is refused at once, also by connections that were already open.
So one address can test at most 2 passphrases (the parallel scrypt runs) per block period.

## Messages

Every message after the handshake is a SEALED frame:

- **Key:** `clientToHub` or `hubToClient`, depending on the direction.
- **Nonce:** 12 bytes: 4 zero bytes | 64-bit message counter of that direction, starting at 0.
- **Additional authenticated data:** the 5-byte frame header.

The plaintext is `kind (u8) | payload`:

| Kind | Name | Payload |
|---|---|---|
| 1 | CLIP | clipboard text, UTF-8, unchanged |
| 2 | PING | empty; the peer answers with PONG |
| 3 | PONG | empty |
| 4 | INFO | JSON `{"name": string, "version": string, "maxTextBytes": number}`, sent first by both sides |

A receiver ignores unknown kinds, so later versions can add messages.
The receiver closes the connection when the text is above its own limit (`--max-size`, at most 64 MiB).
The sender does not send text:

- above `min(own limit, peer limit)`;
- to a peer that has not sent INFO yet (its limit is unknown);
- to a peer whose send queue already holds more than one maximum-size text + 1 MiB (the peer does not read).

Liveness:

- A side sends PING when it sent nothing for 15 s (it checks every 5 s, on a monotonic clock).
- A side closes the connection when it received no bytes for 45 s. Every received chunk counts,
  so a large text on a slow link does not trigger the timeout.
- TCP keepalive is on as well.

## Hub behaviour

- **Text from a client:** the hub writes it to its own clipboard (unless `--no-clipboard`) and forwards it to all other clients. The sender does not get it back.
- **Local copy on the hub:** the hub sends it to all clients.
- **No peers connected:** the clipboard is not read.
- **Echo suppression:** based on content, not on a time window. The text that netpaste writes becomes the "last known" value, so the next poll sees no change. A poll that overlaps a write is discarded.

## Discovery

The hub announces `_netpaste._tcp.local` with TXT `v=2`. The instance name is the computer name.

The SRV target is a separate name for each run, `netpaste-<name>-<random>.local`, not the computer's own
`<name>.local`. The system mDNS responder (mDNSResponder on macOS, Avahi on Linux) owns `<name>.local`.
If a second responder announces A/AAAA records for that name, the system sees a conflict and renames the
computer, for example to `<name>-2.local`. Clients connect to the address the answer came from.

`netpaste connect` without HOST searches for 3 s:

- exactly one hub found: the client connects to it;
- several hubs found: the client lists them and tries again with backoff (give HOST to choose one);
- no hub found: the client tries again with backoff.

`netpaste serve --host ADDR` with a specific address does not announce the hub: bonjour-service
announces the addresses of all interfaces, and clients would connect to an address the hub does not listen on.

## Security properties

| Threat | Result |
|---|---|
| Passive eavesdropper | Cannot read messages. Cannot test passphrase guesses: the proofs depend on the X25519 secret. |
| Stranger connects to the hub | Receives only the hub's HELLO: one ephemeral key, nothing that depends on the passphrase. Costs the hub a scrypt run only together with a passphrase attempt. At most 2 guesses per block period from one address (see the limits above). |
| Changed, replayed, reordered or reflected message | GCM authentication fails, the connection closes. Keys differ per direction and per connection. |
| Recorded traffic, passphrase leaks later | Old sessions stay secret: the keys also depend on ephemeral X25519 keys (forward secrecy). |
| Active attacker poses as the hub (mDNS spoofing, MITM) | Can try passphrase guesses **offline** against the client proof, one scrypt run per guess. Both sides contribute to the salt, so precomputed tables do not help. Only a long passphrase protects here; a PAKE (for example CPace) would remove this attack. |
| Malformed input or a flood | Closes that connection. Frame sizes are checked before buffering; unread input is limited by TCP flow control. |

Not hidden: the size of each message, and the time of each copy.

## Known limitations

- **Crossing copies.** If two machines copy different texts within about one poll interval (1 s),
  the hub forwards each text to the other machine. Each machine then keeps the other's text, and the hub
  keeps the one it received last, until the next copy. A fix (the hub orders all copies and echoes them to
  the sender) would make the sender's clipboard flicker, so it is not done.
- **Copies while disconnected** are not sent later: the clipboard can change on other machines meanwhile.

## Changes from version 1

Version 1 had these problems:

- unauthenticated AES-CTR: anyone could change text, and could forge messages from the known HELLO plaintext;
- the HELLO message gave material for offline passphrase guessing to anyone who connected;
- the framing broke on normal TCP segmentation;
- input of 4 bytes crashed the process.

Version 2 replaces the whole wire format.
