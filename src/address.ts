import net from 'node:net';

/** "192.168.1.5:8134", "[fe80::1]:8134"; IPv4-mapped IPv6 addresses are shown as IPv4. */
export function formatAddress(address: string | undefined, port: number | undefined): string {
  if (!address) return 'unknown';
  const host = unmapIPv4(address);
  const shown = host.includes(':') ? `[${host}]` : host;
  return port === undefined ? shown : `${shown}:${port}`;
}

/**
 * Key for per-address limits and blocks: the IPv4 address, or the /64 prefix of an IPv6 address.
 * One host usually owns a whole IPv6 /64, so blocking single IPv6 addresses would be easy to evade.
 */
export function addressKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const host = unmapIPv4(address);
  if (!net.isIPv6(host)) return host;
  const [withoutZone = ''] = host.split('%');
  const [head = '', tail] = withoutZone.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group || '0', 16).toString(16))
    .join(':')}::/64`;
}

function unmapIPv4(address: string): string {
  return address.startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address;
}
