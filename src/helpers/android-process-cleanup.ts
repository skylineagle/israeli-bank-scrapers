type AndroidCleanupTask = {
  id: string;
  shutdown: () => void;
};

const tasks = new Map<string, AndroidCleanupTask>();
let handlersRegistered = false;

const runAll = (): void => {
  for (const task of tasks.values()) {
    try {
      task.shutdown();
    } catch {
      /* ignore cleanup errors during process exit */
    }
  }
  tasks.clear();
};

export const registerAndroidProcessCleanup = (id: string, shutdown: () => void): void => {
  tasks.set(id, { id, shutdown });
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;
  process.once('SIGINT', runAll);
  process.once('SIGTERM', runAll);
  process.once('exit', runAll);
};

export const unregisterAndroidProcessCleanup = (id: string): void => {
  tasks.delete(id);
};

export const shutdownAllAndroidProcessResources = (): void => {
  runAll();
};
