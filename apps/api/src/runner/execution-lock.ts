/** Prevents the embedded API worker from claiming a second job while one is running. */
let busy = false;

export function isRunnerExecutionBusy(): boolean {
  return busy;
}

export async function withRunnerExecutionLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (busy) return null;
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}
