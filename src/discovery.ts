/**
 * LAN discovery with mDNS / DNS-SD: the server announces `_netpaste._tcp.local`,
 * `netpaste connect` without HOST looks for it.
 *
 * mDNS is not authenticated: any device on the network can announce a service.
 * A fake server still cannot pass the handshake, but see docs/PROTOCOL.md about offline guessing.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import Bonjour from 'bonjour-service';
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from './config.ts';
import { type Logger, sanitizeForTerminal } from './log.ts';

export interface FoundServer {
  name: string;
  host: string;
  port: number;
}

export interface MdnsTransport {
  /** multicast-dns options. Tests use a private port on the loopback interface. */
  interface?: string;
  bind?: string;
  port?: number;
  reuseAddr?: boolean;
}

export interface Advertisement {
  stop(): Promise<void>;
}

type BonjourOptions = ConstructorParameters<typeof Bonjour>[0];

/**
 * bonjour-service does not listen for 'error' on its multicast-dns socket, so a failed bind
 * (UDP 5353 taken, no permission) would be an uncaught exception that stops netpaste.
 */
function createBonjour(transport: MdnsTransport | undefined, onError: (error: Error) => void): Bonjour {
  const bonjour = new Bonjour(transport as BonjourOptions, onError);
  const mdns = (bonjour as unknown as { server?: { mdns?: NodeJS.EventEmitter } }).server?.mdns;
  mdns?.on('error', onError);
  mdns?.on('warning', () => undefined);
  return bonjour;
}

/**
 * The SRV target host name, unique to this process.
 *
 * bonjour-service uses os.hostname() by default and announces A/AAAA records for it.
 * On macOS that is "Name.local", which mDNSResponder already owns: it sees a conflict and
 * renames the computer ("Name-2.local"). Avahi on Linux can react the same way.
 * Our own name avoids the conflict; clients use the addresses from the answer anyway.
 */
export function serviceHostName(name: string, suffix = crypto.randomBytes(3).toString('hex')): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
  return `netpaste-${slug}-${suffix}.local`;
}

export function advertise(port: number, name: string, log: Logger, transport?: MdnsTransport): Advertisement {
  const report = (error: Error) => log.warn(`mDNS announcement failed: ${error.message}`);
  const bonjour = createBonjour(transport, report);
  const service = bonjour.publish({
    name,
    host: serviceHostName(name),
    type: MDNS_SERVICE_TYPE,
    port,
    txt: { v: String(PROTOCOL_VERSION) },
  });
  service.on('error', report);
  let stopped: Promise<void> | null = null;
  return {
    stop() {
      stopped ??= Promise.race([
        new Promise<void>((resolve) => bonjour.unpublishAll(() => bonjour.destroy(() => resolve()))),
        sleep(1500),
      ]);
      return stopped;
    },
  };
}

/** Searches for `timeoutMs`. Rejects with the signal's reason when the signal aborts first. */
export async function discoverServers(timeoutMs: number, transport?: MdnsTransport, signal?: AbortSignal): Promise<FoundServer[]> {
  signal?.throwIfAborted();
  let failure: Error | null = null;
  const bonjour = createBonjour(transport, (error: Error) => {
    failure ??= error;
  });
  const found = new Map<string, FoundServer>();
  const browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (service) => {
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    if (String(txt.v) !== String(PROTOCOL_VERSION)) return;
    const host = pickAddress(service.addresses ?? [], service.referer?.address);
    if (!host || !Number.isInteger(service.port)) return;
    const name = sanitizeForTerminal(service.name) || 'unnamed';
    found.set(`${name}|${host}|${service.port}`, { name, host, port: service.port });
  });
  try {
    await sleep(timeoutMs, undefined, signal ? { signal } : {});
  } finally {
    browser.stop();
    await Promise.race([new Promise<void>((resolve) => bonjour.destroy(() => resolve())), sleep(1000)]);
  }
  if (failure && found.size === 0) throw new Error(`mDNS search failed: ${(failure as Error).message}`);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
}

/**
 * Chooses the address to connect to. Prefers the address the answer came from: the server
 * announces all its interfaces (Docker bridges and VPNs too), but it answers from the one
 * that faces us. Then IPv4, then a non-link-local IPv6 address (link-local needs a zone index).
 */
export function pickAddress(addresses: readonly string[], referer?: string): string | null {
  if (referer && net.isIPv4(referer)) return referer;
  const ipv4 = addresses.find((address) => net.isIPv4(address));
  if (ipv4) return ipv4;
  const ipv6 = addresses.find((address) => net.isIPv6(address) && !/^fe[89ab]/i.test(address));
  if (ipv6) return ipv6;
  return referer && net.isIP(referer) ? referer : null;
}
