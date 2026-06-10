/**
 * Simple asynchronous Mutex lock to enforce concurrency control
 * and prevent duplicate, overlapping execution loops.
 */
export class Mutex {
  private promise: Promise<void> = Promise.resolve();

  /**
   * Acquire the lock. Returns a function to release the lock when complete.
   */
  async acquire(): Promise<() => void> {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentPromise = this.promise;
    this.promise = nextPromise;
    await currentPromise;
    return () => {
      release();
    };
  }
}
export const tradingTickMutex = new Mutex();
