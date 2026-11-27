/** Run all cleanup steps in order, including after a step fails. */
export async function collectCleanupErrors(cleanups) {
  const errors = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}
