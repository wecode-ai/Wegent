export async function cleanupNativeMcpResources(cleanups, failure) {
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      if (failure === undefined) failure = error
    }
  }
  if (failure !== undefined) throw failure
}
