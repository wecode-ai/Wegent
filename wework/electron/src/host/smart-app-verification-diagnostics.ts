export async function traceSmartAppVerification<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  console.info('[Wework] Smart App verification', { stage, phase: 'started' })
  try {
    const result = await operation()
    console.info('[Wework] Smart App verification', {
      stage,
      phase: 'finished',
      elapsedMs: Date.now() - startedAt,
    })
    return result
  } catch (error) {
    console.info('[Wework] Smart App verification', {
      stage,
      phase: 'failed',
      elapsedMs: Date.now() - startedAt,
    })
    throw error
  }
}
