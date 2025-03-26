/**
 * A simple function to schedule a task to run after a delay
 * This replaces Trigger.dev's delayed execution functionality
 */
export function scheduleTask<T>(
  task: (payload: T) => Promise<void>,
  payload: T,
  delayMs: number = 0,
): Promise<void> {
  return new Promise((resolve) => {
    // Store the task in memory to be executed after the delay
    setTimeout(async () => {
      try {
        await task(payload);
        resolve();
      } catch (error) {
        console.error("Error executing scheduled task:", error);
        resolve();
      }
    }, delayMs);

    console.log(`Task scheduled to run in ${delayMs}ms`);
  });
}
