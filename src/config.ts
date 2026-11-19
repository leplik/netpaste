/** Wire protocol version spoken by this build. Version 1 (netpaste 1.x) is not compatible. */
export const PROTOCOL_VERSION = 2;

export const DEFAULT_PORT = 8134;

/** mDNS / DNS-SD service type: `_netpaste._tcp.local`. */
export const MDNS_SERVICE_TYPE = 'netpaste';

/** Default upper limit for one clipboard text, in UTF-8 bytes. */
export const DEFAULT_MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const MIN_TEXT_BYTES = 1024;
/** clipboardy reads through execa with a 100 MB output limit; stay well below it. */
export const MAX_TEXT_BYTES_CEILING = 64 * 1024 * 1024;

export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const MIN_POLL_INTERVAL_MS = 100;
export const MAX_POLL_INTERVAL_MS = 60_000;

/** Most authenticated peers of one hub. */
export const MAX_SESSIONS = 32;
/** Most connections that have not proved the passphrase yet: in total, and from one address (IPv6: one /64). */
export const MAX_PENDING = 32;
export const MAX_PENDING_PER_ADDRESS = 4;
/** Hard cap for all TCP connections of the hub; Node closes connections above it. */
export const MAX_CONNECTIONS = MAX_SESSIONS + MAX_PENDING + 16;

/** How many passphrase key derivations (scrypt, ~128 MiB each) the server runs at once. */
export const MAX_CONCURRENT_KDF = 2;

export interface Timings {
  /** Time from TCP connect to a finished handshake. */
  handshakeTimeoutMs: number;
  /** Send a PING when nothing was sent for this long. */
  heartbeatIntervalMs: number;
  /** Close the connection when nothing was received for this long. */
  idleTimeoutMs: number;
  /** First reconnect delay of the client. The delay doubles up to `reconnectMaxMs`. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** The server waits this long before it reports a wrong passphrase. Slows down online guessing. */
  authFailureDelayMs: number;
  /**
   * After a wrong passphrase the server refuses that IP address for this long.
   * The time doubles with every further failure, up to `authBlockMaxMs`.
   */
  authBlockBaseMs: number;
  authBlockMaxMs: number;
  /** TCP connect timeout of the client. */
  connectTimeoutMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  handshakeTimeoutMs: 10_000,
  heartbeatIntervalMs: 15_000,
  idleTimeoutMs: 45_000,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
  authFailureDelayMs: 1_000,
  authBlockBaseMs: 1_000,
  authBlockMaxMs: 60_000,
  connectTimeoutMs: 10_000,
};
