const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1_000

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

export async function retryOperation(
  operation,
  {
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleepImpl = sleep,
    onRetry,
  } = {}
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Retry attempts must be a positive integer')
  }

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const delayMs = retryDelayMs * attempt
      onRetry?.({ attempt, attempts, delayMs, error })
      await sleepImpl(delayMs)
    }
  }

  throw lastError
}
