import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from './log.ts';

export interface ClipboardBackend {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/** The system clipboard (pbcopy/pbpaste, wl-clipboard, xsel, PowerShell) through clipboardy. */
export async function systemClipboard(): Promise<ClipboardBackend> {
  const { default: clipboardy } = await import('clipboardy');
  return {
    read: () => clipboardy.read(),
    write: (text) => clipboardy.write(text),
  };
}

export interface ClipboardWatcherOptions {
  intervalMs: number;
  log: Logger;
}

interface ClipboardWatcherEvents {
  /** The user changed the local clipboard. Not emitted for text that came from `apply()`. */
  change: [text: string];
}

/**
 * Polls the clipboard in a sequential loop (one read at a time) and reports local changes.
 *
 * Echo suppression is content-based: `apply()` records the text it writes, so the next poll
 * sees no change. A read that overlaps a write is dropped, because it can return the old text.
 * There is no time window, so a local copy right after a received one is not lost.
 *
 * The hub and the client start the watcher only while a peer is connected: without a peer
 * there is nowhere to send the text, so netpaste does not read the clipboard at all.
 */
export class ClipboardWatcher extends EventEmitter<ClipboardWatcherEvents> {
  readonly #backend: ClipboardBackend;
  readonly #options: ClipboardWatcherOptions;
  #last: string | null = null;
  #generation = 0;
  #pendingWrites = 0;
  #writeQueue: Promise<unknown> = Promise.resolve();
  #readFailing = false;
  #running: AbortController | null = null;
  /** The next successful read is the baseline: it is remembered, not reported. */
  #baselinePending = false;

  constructor(backend: ClipboardBackend, options: ClipboardWatcherOptions) {
    super();
    this.#backend = backend;
    this.#options = options;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /**
   * Takes the current text as the baseline (it is not reported) and starts polling.
   * When the first read fails (no display yet), the first successful read becomes the baseline,
   * so old clipboard content is never sent out just because netpaste started.
   * Does nothing when the watcher already runs.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    const controller = new AbortController();
    this.#running = controller;
    this.#baselinePending = true;
    await this.poll();
    if (controller.signal.aborted) return;
    void this.#loop(controller.signal);
  }

  stop(): void {
    this.#running?.abort();
    this.#running = null;
  }

  /** One polling step. `start()` calls it in a loop; tests call it directly. */
  async poll(): Promise<void> {
    if (this.#pendingWrites > 0) return;
    const generation = this.#generation;
    const text = await this.#read();
    if (text === null) return;
    if (generation !== this.#generation || this.#pendingWrites > 0) return;
    if (this.#baselinePending) {
      this.#baselinePending = false;
      this.#last = text;
      return;
    }
    if (text === this.#last) return;
    this.#last = text;
    // An empty result means a cleared clipboard or non-text content (an image, files): nothing to send.
    if (text.length === 0) return;
    this.emit('change', text);
  }

  /** Writes text from the network to the local clipboard without reporting it as a local change. */
  async apply(text: string): Promise<void> {
    this.#baselinePending = false;
    if (text === this.#last && this.#pendingWrites === 0) return;
    this.#last = text;
    this.#generation++;
    this.#pendingWrites++;
    const write = this.#writeQueue.then(() => this.#backend.write(text));
    this.#writeQueue = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.#options.log.error(`cannot write to the clipboard: ${errorMessage(error)}`);
      // The clipboard content is unknown now. The next successful poll takes it as the baseline
      // and does not send it, so old text never goes out as a "new" copy. A copy that the user
      // makes during this short window is not sent either: that is the safer of the two failures.
      // (A re-read here could overlap the next queued write and cause an echo.)
      this.#baselinePending = true;
    } finally {
      this.#pendingWrites--;
      this.#generation++;
    }
  }

  async #loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await sleep(this.#options.intervalMs, undefined, { signal });
      } catch {
        return;
      }
      await this.poll();
    }
  }

  async #read(): Promise<string | null> {
    try {
      const text = await this.#backend.read();
      if (this.#readFailing) {
        this.#readFailing = false;
        this.#options.log.info('the clipboard is readable again');
      }
      return text;
    } catch (error) {
      if (!this.#readFailing) {
        this.#readFailing = true;
        this.#options.log.warn(`cannot read the clipboard: ${errorMessage(error)}`);
      }
      return null;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}
