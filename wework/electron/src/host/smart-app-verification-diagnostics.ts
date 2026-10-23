export async function traceSmartAppVerification<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  console.info('[smart-app-verification]', {
    stage,
    status: 'started',
    timestamp: new Date(startedAt).toISOString(),
  })
  let status = 'failed'
  try {
    const result = await operation()
    status = 'completed'
    return result
  } finally {
    console.info('[smart-app-verification]', {
      stage,
      status,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    })
  }
}
