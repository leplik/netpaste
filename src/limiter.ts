/** Runs at most `max` async tasks at the same time; the other tasks wait in FIFO order. */
export class Limiter {
  readonly #max: number;
  #active = 0;
  #waiting: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    this.#max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active < this.#max) this.#active++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot to the next task, or free it.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
