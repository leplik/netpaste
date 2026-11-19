#!/usr/bin/env node
// Plain JavaScript on purpose: it runs on any Node.js version and explains what is missing.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`netpaste needs Node.js 22.18 or newer (it runs TypeScript directly); this is Node.js ${process.versions.node}.`);
  process.exit(1);
}
await import('../src/cli.ts');
