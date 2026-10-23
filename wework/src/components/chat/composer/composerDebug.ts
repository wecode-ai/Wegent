export { textMetrics } from '@wegent/collaboration/composer'
export function debugComposerEvent(event: string, details: Record<string, unknown>) {
  if (import.meta.env.VITE_WEWORK_E2E === 'true') {
    console.error('[desktop-e2e-composer]', JSON.stringify({ event, at: Date.now(), ...details }))
    return
  }
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
