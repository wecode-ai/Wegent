/** A browser Web Locks test double; real desktop coverage uses Chromium's manager. */
export function createTestWebLocks(): LockManager {
  const tails = new Map<string, Promise<void>>()
  return {
    request<T>(
      name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>
    ) {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
      const granted = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!
      const previous = tails.get(name) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>(resolve => (release = resolve))
      tails.set(name, held)
      return new Promise<Awaited<T>>((resolve, reject) => {
        const abort = () => reject(options.signal?.reason)
        options.signal?.addEventListener('abort', abort, { once: true })
        void previous.then(async () => {
          options.signal?.removeEventListener('abort', abort)
          try {
            options.signal?.throwIfAborted()
            resolve(await granted({ name, mode: 'exclusive' } as Lock))
          } catch (error) {
            reject(error)
          } finally {
            release()
            if (tails.get(name) === held) tails.delete(name)
          }
        })
      })
    },
    query: async () => ({ held: [], pending: [] }),
  }
}
