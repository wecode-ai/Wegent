const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])
const NAMED_CODE_KEYS = new Set([
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

export function parseDesktopControlKey(value: string): KeyboardEventInit {
  if (value === '+') return { key: '+' }
  const parts = value.split('+').filter(Boolean)
  const keyPart = [...parts].reverse().find(part => !MODIFIER_KEYS.has(part)) ?? ''
  const key =
    keyPart === 'Plus' ? '+' : keyPart === 'Minus' ? '-' : keyPart === 'Space' ? ' ' : keyPart

  return {
    key,
    ...(NAMED_CODE_KEYS.has(keyPart) ? { code: keyPart } : {}),
    altKey: parts.includes('Alt'),
    ctrlKey: parts.includes('Control'),
    metaKey: parts.includes('Meta'),
    shiftKey: parts.includes('Shift'),
  }
}
