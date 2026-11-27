interface FocusTarget {
  isFocused(): boolean
  on(event: 'focus', listener: () => void): unknown
  removeListener(event: 'focus', listener: () => void): unknown
}

interface BlurTarget {
  isFocused(): boolean
  on(event: 'blur', listener: () => void): unknown
  removeListener(event: 'blur', listener: () => void): unknown
}

/** Native activation is asynchronous; acknowledge E2E focus only after the host observes it. */
export function focusE2EWindow(target: FocusTarget, activate: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      target.removeListener('focus', focused)
    }
    const focused = () => {
      if (!target.isFocused()) return false
      cleanup()
      resolve()
      return true
    }
    const timeout = setTimeout(() => {
      // Native state can settle without another focus notification.
      if (focused()) return
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

/** Native deactivation is asynchronous; acknowledge E2E blur only after focus is gone. */
export function blurE2EWindow(target: BlurTarget, deactivate: () => void): Promise<void> {
  if (!target.isFocused()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      target.removeListener('blur', blurred)
    }
    const blurred = () => {
      try {
        if (target.isFocused()) return false
      } catch (error) {
        cleanup()
        reject(error)
        return true
      }
      cleanup()
      resolve()
      return true
    }
    const timeout = setTimeout(() => {
      if (blurred()) return
      cleanup()
      reject(new Error('Native window did not lose focus'))
    }, 5000)
    target.on('blur', blurred)
    try {
      deactivate()
      blurred()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
