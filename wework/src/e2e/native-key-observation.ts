export function createNativeKeyAttributeObservation(
  target: EventTarget,
  read: () => string | null
) {
  let value: string | null | undefined
  return {
    record(event: Pick<KeyboardEvent, 'isTrusted' | 'target'>) {
      if (value === undefined && event.isTrusted && event.target === target) value = read()
    },
    result(): string {
      if (value == null) throw new Error('Native key attribute observation is unavailable')
      return value
    },
  }
}
