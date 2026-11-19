import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError, parseCommandLine, parseSize, parseTarget } from '../src/args.ts';

describe('parseCommandLine', () => {
  it('parses serve with defaults and with all options', () => {
    assert.deepEqual(parseCommandLine(['serve']), {
      name: 'serve',
      port: 8134,
      host: undefined,
      clipboard: true,
      mdns: true,
      options: { passphraseFile: undefined, intervalMs: 1000, maxTextBytes: 10 * 1024 * 1024, verbose: false },
    });
    const command = parseCommandLine(['serve', '-p', '9000', '--host', '127.0.0.1', '--no-clipboard', '--no-mdns', '--max-size', '1mb']);
    assert.equal(command.name, 'serve');
    if (command.name !== 'serve') return;
    assert.equal(command.port, 9000);
    assert.equal(command.host, '127.0.0.1');
    assert.equal(command.clipboard, false);
    assert.equal(command.mdns, false);
    assert.equal(command.options.maxTextBytes, 1024 * 1024);
  });

  it('parses connect with and without a host', () => {
    const withHost = parseCommandLine(['connect', 'box.local:9000', '--interval', '250']);
    assert.ok(withHost.name === 'connect');
    assert.deepEqual(withHost.target, { host: 'box.local', port: 9000 });
    assert.equal(withHost.options.intervalMs, 250);
    const discovered = parseCommandLine(['connect']);
    assert.ok(discovered.name === 'connect');
    assert.equal(discovered.target, null);
  });

  it('accepts flags before the host (1.x took "--no-clipboard" as the host name)', () => {
    const command = parseCommandLine(['connect', '--no-clipboard', 'box']);
    assert.ok(command.name === 'connect');
    assert.deepEqual(command.target, { host: 'box', port: 8134 });
    assert.equal(command.clipboard, false);
  });

  it('rejects bad input instead of silently using port 8134', () => {
    for (const argv of [
      ['connect', 'box', 'extra'],
      ['connect', 'box:abc'],
      ['connect', 'box', '--port', '0'],
      ['connect', 'box:9000', '--port', '9001'],
      ['connect', '--port', '9000'],
      ['serve', '--port', '70000'],
      ['serve', '--timeout', '3'],
      ['serve', '--unknown'],
      ['serve', '--interval', '5'],
      ['discover', 'host'],
      ['launch'],
    ]) {
      assert.throws(() => parseCommandLine(argv), UsageError, argv.join(' '));
    }
  });

  it('shows help and version', () => {
    assert.deepEqual(parseCommandLine([]), { name: 'help' });
    assert.deepEqual(parseCommandLine(['serve', '--help']), { name: 'help' });
    assert.deepEqual(parseCommandLine(['-v']), { name: 'version' });
  });

  it('parses discover', () => {
    assert.deepEqual(parseCommandLine(['discover', '--timeout', '1.5']), { name: 'discover', timeoutMs: 1500, verbose: false });
  });
});

describe('parseTarget', () => {
  it('handles IPv4, names, IPv6 with and without brackets', () => {
    assert.deepEqual(parseTarget('192.168.1.5'), { host: '192.168.1.5', port: 8134 });
    assert.deepEqual(parseTarget('[::1]:9000'), { host: '::1', port: 9000 });
    assert.deepEqual(parseTarget('[fe80::1]'), { host: 'fe80::1', port: 8134 });
    assert.deepEqual(parseTarget('fe80::1'), { host: 'fe80::1', port: 8134 });
    assert.deepEqual(parseTarget('box', 9100), { host: 'box', port: 9100 });
    assert.deepEqual(parseTarget('my_box.local.'), { host: 'my_box.local.', port: 8134 });
  });

  it('rejects things that are not host names instead of retrying DNS forever', () => {
    for (const value of ['box:9000:1', 'http://box:8134', 'bad host', '-box', 'a..b', '[nonsense]:8134']) {
      assert.throws(() => parseTarget(value), UsageError, value);
    }
  });
});

describe('parseSize', () => {
  it('understands units', () => {
    assert.equal(parseSize('10mb'), 10 * 1024 * 1024);
    assert.equal(parseSize('512KB'), 512 * 1024);
    assert.equal(parseSize('0.5m'), 512 * 1024);
    assert.equal(parseSize('4096'), 4096);
  });

  it('rejects junk and out-of-range values', () => {
    for (const value of ['abc', '10tb', '1b', '1000mb', '100mb', '']) assert.throws(() => parseSize(value), UsageError, value);
    assert.equal(parseSize('64mb'), 64 * 1024 * 1024);
  });
});
