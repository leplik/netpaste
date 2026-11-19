import { main } from './main.ts';

try {
  const code = await main({
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
} catch (error) {
  process.stderr.write(`netpaste: unexpected error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
