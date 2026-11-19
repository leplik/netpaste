import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import os from 'node:os';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import Bonjour from 'bonjour-service';
import { advertise, discoverServers, pickAddress, serviceHostName } from '../src/discovery.ts';
import { recordingLogger, waitFor } from './helpers.ts';

describe('pickAddress', () => {
  it('prefers the address the answer came from', () => {
    assert.equal(pickAddress(['172.17.0.1', '192.168.1.5'], '192.168.1.5'), '192.168.1.5');
    assert.equal(pickAddress(['192.168.1.5'], '127.0.0.1'), '127.0.0.1');
  });

  it('falls back to IPv4, then to a routable IPv6 address', () => {
    assert.equal(pickAddress(['fe80::1', '192.168.1.5']), '192.168.1.5');
    assert.equal(pickAddress(['fe80::1', '2001:db8::5']), '2001:db8::5');
    assert.equal(pickAddress(['fe80::1']), null);
  });
});

// Real multicast on the loopback interface and a private port, so nothing leaves this machine.
// CI runners often have no multicast; set NETPASTE_TEST_MDNS=1 to force the test there.
const skipLive = process.env.CI !== undefined && process.env.NETPASTE_TEST_MDNS !== '1';
const privateTransport = () => ({ interface: '127.0.0.1', bind: '0.0.0.0', port: 20000 + Math.floor(Math.random() * 20000) });

describe('mDNS', () => {
  it('finds an announced server', { skip: skipLive }, async () => {
    const transport = privateTransport();
    const log = recordingLogger();
    const announcement = advertise(9555, 'test-hub', log, transport);
    try {
      const servers = await discoverServers(1500, transport);
      assert.deepEqual(
        servers.filter((server) => server.name === 'test-hub'),
        [{ name: 'test-hub', host: '127.0.0.1', port: 9555 }],
      );
    } finally {
      await announcement.stop();
    }
    assert.equal(log.lines.filter((line) => line.level === 'warn' || line.level === 'error').length, 0);
  });

  it('never announces records for the computer host name (macOS would rename the computer)', { skip: skipLive }, async () => {
    const transport = privateTransport();
    const sniffer = new Bonjour(transport as ConstructorParameters<typeof Bonjour>[0]);
    const mdns = (sniffer as unknown as { server: { mdns: NodeJS.EventEmitter } }).server.mdns;
    const records: Array<{ name: string; type: string; data: unknown }> = [];
    mdns.on('response', (packet: { answers: typeof records; additionals: typeof records }) => {
      records.push(...packet.answers, ...packet.additionals);
    });
    const announcement = advertise(9556, 'Aliaksei MacBook', recordingLogger(), transport);
    const browser = sniffer.find({ type: 'netpaste' });
    await sleep(1500);
    browser.stop();
    await announcement.stop();
    await new Promise<void>((resolve) => sniffer.destroy(() => resolve()));

    const own = os.hostname().toLowerCase().replace(/\.local$/, '');
    const names = records.map((record) => record.name.toLowerCase());
    assert.ok(names.length > 0, 'the announcement was captured');
    assert.ok(!names.some((name) => name === own || name === `${own}.local`), `no record for ${own}.local`);
    const srv = records.find((record) => record.type === 'SRV');
    assert.match((srv?.data as { target: string }).target, /^netpaste-aliaksei-macbook-[0-9a-f]{6}\.local$/);
  });

  it('builds a valid DNS label for the service host', () => {
    assert.equal(serviceHostName('Aliaksei’s MacBook Pro', 'abc123'), 'netpaste-aliaksei-s-macbook-pro-abc123.local');
    assert.equal(serviceHostName('***', 'abc123'), 'netpaste-host-abc123.local');
  });

  it('reports a busy mDNS port as a warning instead of crashing', async () => {
    const blocker = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    blocker.bind(0, '0.0.0.0');
    await once(blocker, 'listening');
    const transport = { ...privateTransport(), port: blocker.address().port, reuseAddr: false };
    const log = recordingLogger();
    const announcement = advertise(9555, 'blocked-hub', log, transport);
    try {
      await waitFor(() => log.has('warn', /mDNS announcement failed/), 'warning about the busy port');
    } finally {
      await announcement.stop();
      blocker.close();
    }
  });
});
