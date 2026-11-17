export class KeyedMutex {
  private readonly tails = new Map<number, Promise<void>>();
  async run<T>(key: number, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}
