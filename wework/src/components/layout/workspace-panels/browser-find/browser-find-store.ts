import { DEFAULT_EMBEDDED_BROWSER_LABEL, evalEmbeddedBrowserJson } from '@/lib/embedded-browser'
import { browserFindInjectionScript } from './injection-script'

export interface BrowserFindState {
  query: string
  matches: number
  active: number
}

let cachedInjectionScript: string | null = null

function injectionScript(): string {
  if (cachedInjectionScript === null) {
    cachedInjectionScript = browserFindInjectionScript()
  }
  return cachedInjectionScript
}

function findExpression(call: string): string {
  // The injection script is an IIFE that is a no-op once the runtime exists,
  // so prepending it keeps every call safe across page navigations.
  return `(${injectionScript()}, window.__WEWORK_BROWSER_FIND__.${call})`
}

export async function searchEmbeddedBrowserPage(
  query: string,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<BrowserFindState | null> {
  return evalEmbeddedBrowserJson<BrowserFindState | null>(
    findExpression(`search(${JSON.stringify(query)})`),
    label
  )
}

export async function stepEmbeddedBrowserFind(
  direction: 1 | -1,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<BrowserFindState | null> {
  return evalEmbeddedBrowserJson<BrowserFindState | null>(
    findExpression(direction === 1 ? 'next()' : 'prev()'),
    label
  )
}

export async function clearEmbeddedBrowserFind(
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await evalEmbeddedBrowserJson<BrowserFindState | null>(findExpression('clear()'), label).catch(
    error => {
      console.warn('[Wework][BrowserFind] Failed to clear find marks:', error)
    }
  )
}
