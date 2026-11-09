interface FocusTarget {
  isFocused(): boolean
  on(event: 'focus', listener: () => void): unknown
  removeListener(event: 'focus', listener: () => void): unknown
}

/** Native activation is asynchronous; acknowledge E2E focus only after the host observes it. */
export function focusE2EWindow(target: FocusTarget, activate: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      target.removeListener('focus', focused)
    }
    const focused = () => {
      if (!target.isFocused()) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Native window activation did not acquire focus'))
    }, 5000)
    target.on('focus', focused)
    try {
      activate()
      focused()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
