/** Maintenance must never become a prerequisite for opening the desktop. */
export function startStartupMaintenance(name: string, task: () => unknown): void {
  void Promise.resolve()
    .then(task)
    .catch(error => {
      console.warn(`[startup] ${name} failed`, error)
    })
}

/** Bound each handoff phase without charging native preparation to the fade. */
export async function finishStartupHandoffPhase<T>(
  phase: string,
  task: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Startup ${phase} exceeded 1500ms`)), 1500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
