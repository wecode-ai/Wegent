export function createPreparationObserver({
  checkpoint,
  write = console.log,
  now = () => performance.now(),
}) {
  return async (stage, run) => {
    const startedAt = now()
    const report = status => {
      try {
        write(
          `[desktop-e2e-preparation] ${JSON.stringify({
            checkpoint,
            stage,
            status,
            elapsedMs: Math.round(now() - startedAt),
          })}`
        )
      } catch {
        // Observations must not interrupt preparation or replace its original error.
      }
    }
    report('started')
    try {
      const result = await run()
      report('completed')
      return result
    } catch (error) {
      report('failed')
      throw error
    }
  }
}
