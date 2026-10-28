// Keep cancelled acquisitions tracked through disposal, including results that
// arrive after an earlier cleanup wait timed out. Callers retain their own bounds.
export function createAcquisitionScope(signal) {
  const pending = new Set();
  const disposalFailures = [];
  async function acquire(operation, disposeLate = async () => {}) {
    signal.throwIfAborted();
    const completion = (async () => {
      const value = await operation();
      if (signal.aborted) {
        try { await disposeLate(value); }
        catch (error) { disposalFailures.push(error); throw error; }
        signal.throwIfAborted();
      }
      return value;
    })();
    pending.add(completion);
    try { return await completion; }
    finally { pending.delete(completion); }
  }
  async function settle() {
    await Promise.allSettled([...pending]);
    if (disposalFailures.length) throw new Error(disposalFailures.map(error => error.message).join('; '));
  }
  return { acquire, settle };
}
