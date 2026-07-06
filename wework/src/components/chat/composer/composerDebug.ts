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

export function textMetrics(value: string | undefined | null) {
  const text = value ?? ''
  return {
    length: text.length,
    trimmedLength: text.trim().length,
    lineCount: text.length > 0 ? text.split('\n').length : 0,
  }
}
