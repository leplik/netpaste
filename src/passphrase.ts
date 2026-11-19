import { readFile, stat } from 'node:fs/promises';
import type { Logger } from './log.ts';

export const PASSPHRASE_ENV = 'NETPASTE_PASSPHRASE';
const RECOMMENDED_LENGTH = 12;

export class PassphraseError extends Error {
  override name = 'PassphraseError';
}

export class PromptCancelledError extends Error {
  override name = 'PromptCancelledError';
}

export interface PassphraseSources {
  /** Path from --passphrase-file. It wins over the environment variable. */
  file?: string | undefined;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  prompt: NodeJS.WritableStream;
  log: Logger;
}

/** Order: --passphrase-file, then NETPASTE_PASSPHRASE, then a hidden prompt on the terminal. */
export async function resolvePassphrase({ file, env, stdin, prompt, log }: PassphraseSources): Promise<string> {
  const fromEnv = env[PASSPHRASE_ENV];
  // Child processes (pbcopy, xsel …) inherit the environment; they must not see the passphrase.
  delete env[PASSPHRASE_ENV];
  let passphrase: string;
  if (file) {
    passphrase = await readPassphraseFile(file, log);
  } else if (fromEnv) {
    passphrase = fromEnv;
  } else if (stdin.isTTY) {
    passphrase = await promptHidden('Passphrase: ', stdin, prompt);
  } else {
    throw new PassphraseError(`no passphrase: stdin is not a terminal. Use --passphrase-file or set ${PASSPHRASE_ENV}.`);
  }
  if (passphrase.length === 0) throw new PassphraseError('the passphrase is empty');
  if ([...passphrase].length < RECOMMENDED_LENGTH) {
    log.warn(`the passphrase is short; use ${RECOMMENDED_LENGTH}+ characters or 4+ random words`);
  }
  return passphrase;
}

export async function readPassphraseFile(path: string, log: Logger): Promise<string> {
  let content: string;
  try {
    const info = await stat(path);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      log.warn(`${path} can be read by other users; run: chmod 600 ${path}`);
    }
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new PassphraseError(`cannot read the passphrase file: ${(error as Error).message}`);
  }
  // Editors add a final newline; it is not part of the passphrase.
  return content.replace(/\r?\n$/, '');
}

export function promptHidden(question: string, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const editor = new HiddenLineEditor();
    const wasRaw = input.isRaw;
    output.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    const onData = (data: string) => {
      const echo = editor.feed(data);
      if (echo) output.write(echo);
      if (!editor.done && !editor.cancelled) return;
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (editor.cancelled) reject(new PromptCancelledError('cancelled'));
      else resolve(editor.value);
    };
    input.on('data', onData);
    input.resume();
  });
}

/**
 * Minimal line editor for a hidden input in raw terminal mode. It prints "*" for each character.
 * - Enter ends the input; Ctrl+C cancels; Ctrl+D on an empty line cancels.
 * - Backspace deletes one character (a whole code point, also an emoji); Ctrl+U clears the line.
 * - Escape sequences (arrows, Home, F-keys, bracketed-paste markers) are skipped,
 *   also when a sequence is split between two reads.
 */
export class HiddenLineEditor {
  #chars: string[] = [];
  #escape: string | null = null;
  done = false;
  cancelled = false;

  get value(): string {
    return this.#chars.join('');
  }

  /** Processes raw input and returns the text to echo. */
  feed(input: string): string {
    let echo = '';
    for (const ch of input) {
      if (this.done || this.cancelled) break;
      if (this.#escape !== null) {
        // ESC followed by Enter, Ctrl+C, Backspace … : the ESC was a stray key press, not a sequence.
        if (this.#escape === '\u001b' && /\p{Cc}/u.test(ch) && ch !== '\u001b') {
          this.#escape = null;
        } else {
          this.#escape += ch;
          if (isCompleteEscape(this.#escape)) this.#escape = null;
          continue;
        }
      }
      switch (ch) {
        case '\r':
        case '\n':
          this.done = true;
          break;
        case '\u0003': // Ctrl+C
          this.cancelled = true;
          break;
        case '\u0004': // Ctrl+D
          if (this.#chars.length === 0) this.cancelled = true;
          break;
        case '\u007f': // Backspace on most terminals
        case '\b':
          if (this.#chars.pop() !== undefined) echo += '\b \b';
          break;
        case '\u0015': // Ctrl+U
          echo += '\b \b'.repeat(this.#chars.length);
          this.#chars = [];
          break;
        case '\u001b':
          this.#escape = ch;
          break;
        default:
          // TAB is a valid passphrase character (it is kept in files and in the environment too).
          if (ch === '\t' || !/\p{Cc}/u.test(ch)) {
            this.#chars.push(ch);
            echo += '*';
          }
      }
    }
    return echo;
  }
}

/** ESC x (Alt+key), ESC O x (SS3), ESC [ params final (CSI, final byte 0x40–0x7E). */
function isCompleteEscape(sequence: string): boolean {
  if (sequence.length < 2) return false;
  const kind = sequence[1];
  if (kind === '[') {
    // "ESC [ [ A" is how the Linux console sends F1–F5.
    if (sequence.length < 3 || sequence === '\u001b[[') return false;
    const last = sequence.charCodeAt(sequence.length - 1);
    return last >= 0x40 && last <= 0x7e;
  }
  if (kind === 'O') return sequence.length >= 3;
  return true;
}
