import { createSingleFlight } from '../host/window-presentation.js'

export function createInitialRuntimePreparation<T>(prepare: () => Promise<T>) {
  let pending = Promise.allSettled([prepare()]).then(([result]) => result)
  let initialAvailable = true
  return {
    take: createSingleFlight(async () => {
      if (!initialAvailable) {
        pending = Promise.allSettled([prepare()]).then(([result]) => result)
      }
      initialAvailable = false
      const result = await pending
      if (result.status === 'rejected') throw result.reason
      return result.value
    }),
    async settled(): Promise<void> {
      await pending
    },
  }
}
