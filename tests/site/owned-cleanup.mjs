// Acceptance harness utility: independent resources in a stage close concurrently;
// dependencies wait for the preceding stage. One failure never skips another close.
export function createOwnedCleanup(stages) {
  let completion;
  return () => completion ??= (async () => {
    const results = [];
    for (const stage of stages) {
      results.push(...await Promise.all(stage.map(async ({ name, run, timeoutMs }) => {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(run),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} cleanup deadline exceeded`)), timeoutMs); }),
          ]);
          return { name, status: 'passed' };
        } catch (error) { return { name, status: 'failed', error: error.message }; }
        finally { clearTimeout(timer); }
      })));
    }
    return results;
  })();
}
