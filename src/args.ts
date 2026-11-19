import { parseArgs } from 'node:util';
import {
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PORT,
  MAX_POLL_INTERVAL_MS,
  MAX_TEXT_BYTES_CEILING,
  MIN_POLL_INTERVAL_MS,
  MIN_TEXT_BYTES,
} from './config.ts';

export interface CommonOptions {
  passphraseFile: string | undefined;
  intervalMs: number;
  maxTextBytes: number;
  verbose: boolean;
}

export type Command =
  | { name: 'serve'; port: number; host: string | undefined; clipboard: boolean; mdns: boolean; options: CommonOptions }
  | { name: 'connect'; target: { host: string; port: number } | null; clipboard: boolean; options: CommonOptions }
  | { name: 'discover'; timeoutMs: number; verbose: boolean }
  | { name: 'help' }
  | { name: 'version' };

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE = `netpaste — encrypted clipboard sync between your machines

Usage:
  netpaste serve    [--port N] [--host ADDR] [--no-clipboard] [--no-mdns]
  netpaste connect  [HOST[:PORT]] [--port N] [--no-clipboard]
  netpaste discover [--timeout SEC]

Run "serve" on one machine and "connect" on the others. Without HOST,
"connect" finds the server on the local network (mDNS).

Options:
  -p, --port N              TCP port (default ${DEFAULT_PORT})
      --host ADDR           serve: listen only on this address (default: all)
      --no-clipboard        do not use the local clipboard
                            (serve: only relay text between clients)
      --no-mdns             serve: do not announce the server on the network
      --passphrase-file F   read the passphrase from file F
      --interval MS         clipboard check interval (default ${DEFAULT_POLL_INTERVAL_MS})
      --max-size SIZE       largest text to send or accept (default 10mb)
      --timeout SEC         discover: search time (default 3)
      --verbose             show debug messages
  -h, --help                show this help
  -v, --version             show the version

Passphrase: --passphrase-file, else the NETPASTE_PASSPHRASE variable, else a prompt.
Use the same passphrase on all machines.`;

const OPTIONS = {
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  'no-clipboard': { type: 'boolean' },
  'no-mdns': { type: 'boolean' },
  'passphrase-file': { type: 'string' },
  interval: { type: 'string' },
  'max-size': { type: 'string' },
  timeout: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type OptionName = keyof typeof OPTIONS;

const ALLOWED: Record<'serve' | 'connect' | 'discover', readonly OptionName[]> = {
  serve: ['port', 'host', 'no-clipboard', 'no-mdns', 'passphrase-file', 'interval', 'max-size', 'verbose'],
  connect: ['port', 'no-clipboard', 'passphrase-file', 'interval', 'max-size', 'verbose'],
  discover: ['timeout', 'verbose'],
};

export function parseCommandLine(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { name: 'help' };
  if (values.version) return { name: 'version' };

  const [name, ...rest] = positionals;
  if (name === undefined || name === 'help') return { name: 'help' };
  if (name === 'version') return { name: 'version' };
  if (name !== 'serve' && name !== 'connect' && name !== 'discover') {
    throw new UsageError(`unknown command "${name}"`);
  }
  for (const option of Object.keys(values) as OptionName[]) {
    if (!ALLOWED[name].includes(option)) throw new UsageError(`option --${option} does not apply to "${name}"`);
  }

  const verbose = values.verbose ?? false;
  if (name === 'discover') {
    if (rest.length > 0) throw new UsageError('"discover" takes no arguments');
    const seconds = values.timeout === undefined ? 3 : parseNumber(values.timeout, '--timeout', 0.5, 60);
    return { name, timeoutMs: Math.round(seconds * 1000), verbose };
  }

  const options: CommonOptions = {
    passphraseFile: values['passphrase-file'],
    intervalMs:
      values.interval === undefined
        ? DEFAULT_POLL_INTERVAL_MS
        : Math.round(parseNumber(values.interval, '--interval', MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS)),
    maxTextBytes: values['max-size'] === undefined ? DEFAULT_MAX_TEXT_BYTES : parseSize(values['max-size']),
    verbose,
  };
  const clipboard = !values['no-clipboard'];
  const flagPort = values.port === undefined ? undefined : parsePort(values.port);

  if (name === 'serve') {
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}" for "serve"`);
    return { name, port: flagPort ?? DEFAULT_PORT, host: values.host, clipboard, mdns: !values['no-mdns'], options };
  }

  if (rest.length > 1) throw new UsageError(`unexpected argument "${rest[1]}" for "connect"`);
  const target = rest[0] === undefined ? null : parseTarget(rest[0], flagPort);
  if (!target && flagPort !== undefined) throw new UsageError('--port needs a HOST; without HOST the port comes from mDNS');
  return { name, target, clipboard, options };
}

/** "host", "host:port", "[v6]:port", "v6" (a bare IPv6 address has more than one colon). */
export function parseTarget(value: string, flagPort?: number): { host: string; port: number } {
  let host = value;
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(value);
  if (bracketed) {
    host = bracketed[1]!;
    if (bracketed[2] !== undefined) port = parsePort(bracketed[2]);
  } else if (value.split(':').length === 2) {
    const [h, p] = value.split(':') as [string, string];
    host = h;
    port = parsePort(p);
  }
  if (host.length === 0) throw new UsageError(`invalid host "${value}"`);
  if (port !== undefined && flagPort !== undefined && port !== flagPort) {
    throw new UsageError(`port ${port} in "${value}" conflicts with --port ${flagPort}`);
  }
  return { host, port: port ?? flagPort ?? DEFAULT_PORT };
}

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`invalid port "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new UsageError(`port must be 1–65535, got ${value}`);
  return port;
}

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2 };

/** "10mb", "512k", "1048576" → bytes (binary units). */
export function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  if (!match || unit === undefined) throw new UsageError(`invalid size "${value}" (examples: 512kb, 10mb)`);
  const bytes = Math.floor(Number(match[1]) * unit);
  if (bytes < MIN_TEXT_BYTES || bytes > MAX_TEXT_BYTES_CEILING) {
    throw new UsageError(`--max-size must be between 1kb and ${MAX_TEXT_BYTES_CEILING / 1024 ** 2}mb`);
  }
  return bytes;
}

function parseNumber(value: string, option: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new UsageError(`${option} must be a number between ${min} and ${max}`);
  }
  return number;
}
