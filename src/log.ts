import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  verbose?: boolean;
  out?: NodeJS.WriteStream;
  err?: NodeJS.WriteStream;
}

/** Colors only when the stream is a terminal and NO_COLOR is not set (checked by `styleText`). */
export function createLogger({ verbose = false, out = process.stdout, err = process.stderr }: LoggerOptions = {}): Logger {
  const paint = (style: Style, text: string, stream: NodeJS.WriteStream) => styleText(style, text, { stream });
  const stamp = (stream: NodeJS.WriteStream) => paint('gray', new Date().toLocaleTimeString('en-GB'), stream);
  return {
    info: (message) => out.write(`${stamp(out)} ${message}\n`),
    warn: (message) => err.write(`${stamp(err)} ${paint('yellow', 'warning:', err)} ${message}\n`),
    error: (message) => err.write(`${stamp(err)} ${paint('red', 'error:', err)} ${message}\n`),
    debug: (message) => {
      if (verbose) out.write(`${stamp(out)} ${paint('dim', message, out)}\n`);
    },
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Removes control characters (terminal escape sequences) and limits the length of peer-supplied text. */
export function sanitizeForTerminal(text: string, maxLength = 64): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
