import { afterEach, beforeEach } from 'vitest'

// Match asynchronous Web Locks admission without loading real browser runtimes.
beforeEach(() => {
  const tails = new Map<string, Promise<void>>()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request(name: string, options: LockOptions | (() => unknown), callback?: () => unknown) {
        const signal = typeof options === 'function' ? undefined : options.signal
        const invoke = typeof options === 'function' ? options : callback!
        if (signal?.aborted) return Promise.reject(signal.reason)
        let granted = false
        let abort!: () => void
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => {
            if (!granted) reject(signal?.reason)
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
        const work = (tails.get(name) ?? Promise.resolve()).then(() => {
          signal?.throwIfAborted()
          granted = true
          return invoke()
        })
        const tail = work.then(
          () => {},
          () => {}
        )
        tails.set(name, tail)
        void tail.then(() => {
          if (tails.get(name) === tail) tails.delete(name)
        })
        return Promise.race([work, cancelled]).finally(() =>
          signal?.removeEventListener('abort', abort)
        )
      },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks')
})
