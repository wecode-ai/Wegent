interface InstanceLock {
  releaseSingleInstanceLock(): void
  exit(code: number): void
}

/** A command-only process must never replace a receiver that has already exited. */
export function desktopInstanceMayStart(
  app: InstanceLock,
  ownsInstance: boolean,
  command: string | null
) {
  if (command) {
    if (ownsInstance) {
      app.releaseSingleInstanceLock()
      app.exit(0)
    }
    return false
  }
  return ownsInstance
}
