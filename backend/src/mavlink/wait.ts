import { EventEmitter } from "events";

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Registers a listener for `event`, then calls `send`. Resolves with the first event
 * value accepted by `predicate`. The listener is attached before sending so a fast
 * reply cannot be missed.
 */
export async function sendAndWait<T>(
  emitter: EventEmitter,
  event: string,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  send: () => Promise<void>,
  timeoutMessage = `Timed out waiting for ${event}`
): Promise<T> {
  let cleanup = () => {};
  const waiting = new Promise<T>((resolve, reject) => {
    const onEvent = (value: T) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(timeoutMessage));
    }, timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
    };
    emitter.on(event, onEvent);
  });
  try {
    await send();
  } catch (err) {
    cleanup();
    throw err;
  }
  return waiting;
}

/** Retries `attempt` on TimeoutError only; any other error is thrown immediately. */
export async function withRetries<T>(retries: number, attempt: (n: number) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let n = 0; n < retries; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
