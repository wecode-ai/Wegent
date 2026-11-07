/** Maintenance must never become a prerequisite for opening the desktop. */
export function startStartupMaintenance(name: string, task: () => unknown): void {
  void Promise.resolve()
    .then(task)
    .catch(error => {
      console.warn(`[startup] ${name} failed`, error)
    })
}

/** Animation may decorate startup, but cannot hold a ready window indefinitely. */
export async function finishStartupAnimation(task: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Startup animation exceeded 1500ms')), 1500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
