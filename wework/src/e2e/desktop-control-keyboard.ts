const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

export function parseDesktopControlKey(value: string): KeyboardEventInit {
  if (value === '+') return { key: '+' }
  const parts = value.split('+').filter(Boolean)
  const keyPart = [...parts].reverse().find(part => !MODIFIER_KEYS.has(part)) ?? ''
  const key =
    keyPart === 'Plus' ? '+' : keyPart === 'Minus' ? '-' : keyPart === 'Space' ? ' ' : keyPart

  return {
    key,
    altKey: parts.includes('Alt'),
    ctrlKey: parts.includes('Control'),
    metaKey: parts.includes('Meta'),
    shiftKey: parts.includes('Shift'),
  }
}
