const DSH_BOOT_SELECTOR = '[data-dsh-boot]'
const DSH_PLUGIN_FAILURE_TITLE = 'Failed to load plugins'
const DETECTION_TIMEOUT_MS = 60_000

export interface JavaScriptExecutor {
  executeJavaScript: (code: string) => Promise<unknown>
}

export async function detectCoreDshStartupPluginFailure(
  executor: JavaScriptExecutor,
  pluginNames: string[]
): Promise<string | null> {
  const candidates = [...new Set(pluginNames)]
  if (candidates.length === 0) return null
  const result = await executor.executeJavaScript(detectionScript(candidates))
  return typeof result === 'string' && candidates.includes(result) ? result : null
}

export function detectionScript(pluginNames: string[]): string {
  return `(() => new Promise(resolve => {
    const candidates = ${JSON.stringify(pluginNames)}
    const rootSelector = ${JSON.stringify(DSH_BOOT_SELECTOR)}
    const failureTitle = ${JSON.stringify(DSH_PLUGIN_FAILURE_TITLE)}
    let settled = false
    let observer
    const complete = value => {
      if (settled) return
      settled = true
      observer?.disconnect()
      clearTimeout(timeout)
      resolve(value)
    }
    const inspect = () => {
      const root = document.querySelector(rootSelector)
      if (!root || !root.textContent?.includes(failureTitle)) return
      const texts = new Set(
        [...root.querySelectorAll('*')]
          .map(element => element.textContent?.trim())
          .filter(Boolean)
      )
      complete(candidates.find(name => texts.has(name)) ?? null)
    }
    const timeout = setTimeout(() => complete(null), ${DETECTION_TIMEOUT_MS})
    observer = new MutationObserver(inspect)
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    inspect()
  }))()`
}
