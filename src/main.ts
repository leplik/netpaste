import os from 'node:os';
import { type Command, USAGE, UsageError, parseCommandLine } from './args.ts';
import { Client, FatalError, type Target } from './client.ts';
import { ClipboardWatcher, systemClipboard } from './clipboard.ts';
import { type FoundServer, advertise, discoverServers } from './discovery.ts';
import { type Logger, createLogger, sanitizeForTerminal } from './log.ts';
import { PassphraseError, PromptCancelledError, resolvePassphrase } from './passphrase.ts';
import { Hub } from './server.ts';
import { formatAddress } from './address.ts';
import { VERSION } from './version.ts';

const DISCOVERY_TIMEOUT_MS = 3000;

export interface MainIO {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

/** Runs the command line and returns the exit code. */
export async function main(io: MainIO): Promise<number> {
  let command: Command;
  try {
    command = parseCommandLine(io.argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`netpaste: ${error.message}\nRun "netpaste --help" for usage.\n`);
    return 2;
  }

  switch (command.name) {
    case 'help':
      io.stdout.write(`${USAGE}\n`);
      return 0;
    case 'version':
      io.stdout.write(`${VERSION}\n`);
      return 0;
    case 'discover':
      return discover(command.timeoutMs, createLogger({ verbose: command.verbose, out: io.stdout, err: io.stderr }), io);
    case 'serve':
    case 'connect': {
      const log = createLogger({ verbose: command.options.verbose, out: io.stdout, err: io.stderr });
      try {
        return command.name === 'serve' ? await serve(command, log, io) : await connect(command, log, io);
      } catch (error) {
        if (error instanceof PromptCancelledError) return 130;
        if (error instanceof PassphraseError || error instanceof FatalError) {
          log.error(error.message);
          return 1;
        }
        throw error;
      }
    }
  }
}

async function serve(command: Extract<Command, { name: 'serve' }>, log: Logger, io: MainIO): Promise<number> {
  const passphrase = await resolvePassphrase({ file: command.options.passphraseFile, env: io.env, stdin: io.stdin, prompt: io.stderr, log });
  const clipboard = command.clipboard ? new ClipboardWatcher(await systemClipboard(), { intervalMs: command.options.intervalMs, log }) : null;
  const localName = shortHostname();
  const hub = new Hub({
    port: command.port,
    host: command.host,
    passphrase,
    clipboard,
    maxTextBytes: command.options.maxTextBytes,
    localName,
    version: VERSION,
    log,
  });

  let address;
  try {
    address = await hub.listen();
  } catch (error) {
    throw new FatalError(listenError(error as NodeJS.ErrnoException, command.port, command.host));
  }
  const where = formatAddress(address.address === '::' || address.address === '0.0.0.0' ? '*' : address.address, address.port);
  log.info(`netpaste ${VERSION} is listening on ${where}; ${clipboard ? 'clipboard sync is on' : 'relay only (--no-clipboard)'}`);
  // bonjour-service announces the addresses of all interfaces, so a hub limited by --host is not announced.
  const listensEverywhere = command.host === undefined || command.host === '0.0.0.0' || command.host === '::';
  if (command.mdns && !listensEverywhere) log.info('mDNS announcement is off because --host limits the listen address');
  const announcement = command.mdns && listensEverywhere ? advertise(address.port, localName, log) : null;
  if (announcement) log.info(`announced on the local network as "${localName}"`);

  await waitForSignal();
  log.info('stopping');
  clipboard?.stop();
  await announcement?.stop();
  await hub.close();
  return 0;
}

async function connect(command: Extract<Command, { name: 'connect' }>, log: Logger, io: MainIO): Promise<number> {
  const passphrase = await resolvePassphrase({ file: command.options.passphraseFile, env: io.env, stdin: io.stdin, prompt: io.stderr, log });
  const clipboard = command.clipboard ? new ClipboardWatcher(await systemClipboard(), { intervalMs: command.options.intervalMs, log }) : null;
  const client = new Client({
    target: command.target,
    findServer: command.target ? undefined : (signal) => findSingleServer(log, signal),
    passphrase,
    clipboard,
    maxTextBytes: command.options.maxTextBytes,
    localName: shortHostname(),
    version: VERSION,
    log,
  });
  log.info(`netpaste ${VERSION}; ${clipboard ? 'clipboard sync is on' : 'clipboard is off (--no-clipboard)'}`);

  void waitForSignal().then(() => {
    log.info('stopping');
    return client.close();
  });
  await client.run();
  return 0;
}

async function discover(timeoutMs: number, log: Logger, io: MainIO): Promise<number> {
  let servers: FoundServer[];
  try {
    servers = await discoverServers(timeoutMs);
  } catch (error) {
    log.error((error as Error).message);
    return 1;
  }
  if (servers.length === 0) {
    io.stdout.write('No netpaste servers found on the local network.\n');
    return 0;
  }
  for (const server of servers) io.stdout.write(`${server.name}\t${formatAddress(server.host, server.port)}\n`);
  return 0;
}

/** Not fatal on purpose: anyone on the network can announce a service, and the client keeps trying. */
async function findSingleServer(log: Logger, signal: AbortSignal): Promise<Target> {
  log.debug('looking for a netpaste server on the local network');
  const servers = await discoverServers(DISCOVERY_TIMEOUT_MS, undefined, signal);
  if (servers.length === 0) throw new Error('no netpaste server found on the local network');
  if (servers.length > 1) {
    const list = servers.map((s) => `"${s.name}" at ${formatAddress(s.host, s.port)}`).join(', ');
    throw new Error(`found ${servers.length} servers: ${list}. Choose one: netpaste connect HOST[:PORT]`);
  }
  const [server] = servers as [FoundServer];
  log.info(`found server "${server.name}" at ${formatAddress(server.host, server.port)}`);
  return server;
}

function listenError(error: NodeJS.ErrnoException, port: number, host: string | undefined): string {
  switch (error.code) {
    case 'EADDRINUSE':
      return `port ${port} is already in use. Is another netpaste running? Use --port to choose another port.`;
    case 'EACCES':
      return `no permission to listen on port ${port}`;
    case 'EADDRNOTAVAIL':
      return `address ${host ?? ''} does not belong to this machine`;
    default:
      return `cannot listen on port ${port}: ${error.message}`;
  }
}

function shortHostname(): string {
  return sanitizeForTerminal(os.hostname().replace(/\.local$/i, ''), 63) || 'netpaste';
}

/** Resolves on the first SIGINT/SIGTERM. A second Ctrl+C exits at once. */
function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.once('SIGINT', () => process.exit(130));
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}
