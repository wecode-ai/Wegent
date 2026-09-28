export { textMetrics } from '@wegent/collaboration/composer'
export function debugComposerEvent(event: string, details: Record<string, unknown>) {
  try {
    if (globalThis.localStorage?.getItem('wework:debug-composer') !== '1') return
  } catch {
    return
  }

  console.debug('[Wework] Composer submit flow', {
    event,
    time: new Date().toISOString(),
    ...details,
  })
}
