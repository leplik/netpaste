#!/usr/bin/env node
// Plain JavaScript on purpose: it runs on any Node.js version and explains what is missing.
// Node.js runs TypeScript without flags from 22.18 (22.x line), 23.6 and every later version.
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
if (!supported) {
  console.error(`netpaste needs Node.js 22.18 or newer (it runs TypeScript directly); this is Node.js ${process.versions.node}.`);
  process.exit(1);
}
await import('../src/cli.ts');
