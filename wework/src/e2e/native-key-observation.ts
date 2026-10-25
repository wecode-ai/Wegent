const terminalViewports = new WeakMap<EventTarget, () => number>()

export function registerNativeTerminalViewport(target: EventTarget, read: () => number) {
  terminalViewports.set(target, read)
  return () => terminalViewports.delete(target)
}

export function readNativeTerminalViewport(target: EventTarget): string {
  const position = terminalViewports.get(target)?.()
  if (position == null || !Number.isSafeInteger(position) || position < 1) {
    throw new Error('Native terminal viewport is unavailable')
  }
  return String(position)
}

export function createNativeKeyObservation(target: EventTarget, read: () => string | null) {
  let value: string | null | undefined
  return {
    record(event: Pick<KeyboardEvent, 'isTrusted' | 'target'>) {
      if (value === undefined && event.isTrusted && event.target === target) value = read()
    },
    result(): string {
      if (value == null) throw new Error('Native key observation is unavailable')
      return value
    },
  }
}
