import { once } from 'node:events'

export async function waitForScenarioProgress(events, read, stepCount, timeoutMs) {
  while (true) {
    const { step, error } = read()
    if (error) throw error
    if (step === stepCount) return
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      await once(events, 'change', { signal: abort.signal })
    } catch (error) {
      if (!abort.signal.aborted) throw error
      throw new Error(`Scenario stopped at step ${step}/${stepCount} for ${timeoutMs}ms`)
    } finally {
      clearTimeout(timer)
    }
  }
}
