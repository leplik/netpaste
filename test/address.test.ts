import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressKey, formatAddress } from '../src/address.ts';

describe('addresses', () => {
  it('formats IPv4, IPv4-mapped and IPv6 addresses', () => {
    assert.equal(formatAddress('192.168.1.5', 8134), '192.168.1.5:8134');
    assert.equal(formatAddress('::ffff:192.168.1.5', 8134), '192.168.1.5:8134');
    assert.equal(formatAddress('fe80::1', 8134), '[fe80::1]:8134');
    assert.equal(formatAddress(undefined, 1), 'unknown');
  });

  it('blocks IPv4 per address and IPv6 per /64', () => {
    assert.equal(addressKey('192.168.1.5'), '192.168.1.5');
    assert.equal(addressKey('::ffff:192.168.1.5'), '192.168.1.5');
    assert.equal(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:db8:1:2::99'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(addressKey('::1'), '0:0:0:0::/64');
    assert.equal(addressKey('fe80::1%en0'), 'fe80:0:0:0::/64');
  });
});
