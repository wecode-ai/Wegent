export const name = 'wework-secure-storage'
export const inject = ['weworkDesktop']

export function apply(ctx) {
  const service = Object.freeze({
    scope(namespace) {
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(namespace)) {
        throw new Error('Secure storage namespace is invalid')
      }
      const storageKey = key => {
        if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
          throw new Error('Secure storage key is invalid')
        }
        return `${namespace}.${key}`
      }
      return Object.freeze({
        get: key => ctx.weworkDesktop.secureStorage.get(storageKey(key)),
        set: (key, value) => ctx.weworkDesktop.secureStorage.set(storageKey(key), value),
        delete: key => ctx.weworkDesktop.secureStorage.delete(storageKey(key)),
      })
    },
  })
  ctx.effect(
    () => ctx.reflect.provide('weworkSecureStorage', service),
    'wework-secure-storage: service generation'
  )
}
