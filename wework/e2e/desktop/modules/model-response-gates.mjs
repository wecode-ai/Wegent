export function createModelResponseGates() {
  const pending = new Set()
  let cleanedUp = false

  return {
    pause() {
      const { promise, resolve } = Promise.withResolvers()
      const release = () => {
        pending.delete(release)
        resolve()
      }
      if (cleanedUp) release()
      else pending.add(release)
      return { promise, resolve: release }
    },
    cleanup() {
      cleanedUp = true
      for (const release of pending) release()
    },
  }
}
