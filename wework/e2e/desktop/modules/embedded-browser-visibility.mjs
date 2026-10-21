export async function waitForEmbeddedBrowserVisibility(
  control,
  label,
  expectedVisible,
  timeoutMs,
  message,
  previewSelector
) {
  const startedAt = Date.now()
  let lastState = null
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    if (previewSelector) {
      const errorSelector = `${previewSelector} [data-testid="smart-app-development-preview-error"]`
      if (Number(await control.command('getElementCount', errorSelector)) > 0) {
        const error = await control.command('getText', errorSelector)
        throw new Error(`Smart app development preview failed: ${error}`)
      }
    }
    try {
      lastState = JSON.parse(
        await control.command('getEmbeddedBrowserPageState', 'body', {
          value: label,
        })
      )
      const ready = expectedVisible ? lastState.url && lastState.isLoading === false : true
      if (lastState.visible === expectedVisible && ready) return lastState
    } catch (error) {
      // Reloading temporarily removes the native browser before opening its replacement.
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}: ${JSON.stringify({ state: lastState, error: lastError })}`)
}
