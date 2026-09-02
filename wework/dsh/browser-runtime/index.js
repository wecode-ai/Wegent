import { randomUUID } from 'node:crypto'

export const name = 'wework-browser-runtime'
export const inject = ['weworkDesktop']

export function apply(ctx) {
  let active = true
  const cleanups = new Set()

  const service = Object.freeze({
    requestHeaders: Object.freeze({
      async register(owner, descriptor) {
        if (!active) throw new Error('Wework browser service is disposed')
        const id = `plugin:${randomUUID()}`
        let disposed = false
        const update = async next => {
          if (disposed || !active) throw new Error('Browser auth lease is disposed')
          await ctx.weworkDesktop.browser.setRequestHeaderRule({ ...next, id })
        }
        const dispose = async () => {
          if (disposed) return
          disposed = true
          cleanups.delete(dispose)
          await ctx.weworkDesktop.browser.removeRequestHeaderRule(id)
        }
        await update(descriptor)
        cleanups.add(dispose)
        owner.effect(() => dispose, `wework-browser-runtime: release ${id}`)
        return Object.freeze({ update, dispose })
      },
    }),
    pages: Object.freeze({
      async open(owner) {
        if (!active) throw new Error('Wework browser service is disposed')
        const id = `plugin:${randomUUID()}`
        let closed = false
        const close = async () => {
          if (closed) return
          closed = true
          cleanups.delete(close)
          await ctx.weworkDesktop.browser.closeBackgroundPage(id)
        }
        await ctx.weworkDesktop.browser.createBackgroundPage(id)
        cleanups.add(close)
        owner.effect(() => close, `wework-browser-runtime: close ${id}`)
        return Object.freeze({
          navigate(url) {
            if (closed || !active) throw new Error('Browser page is closed')
            return ctx.weworkDesktop.browser.navigateBackgroundPage(id, url)
          },
          setUserAgent(userAgent) {
            if (closed || !active) throw new Error('Browser page is closed')
            return ctx.weworkDesktop.browser.setBackgroundPageUserAgent(id, userAgent)
          },
          state() {
            if (closed || !active) throw new Error('Browser page is closed')
            return ctx.weworkDesktop.browser.backgroundPageState(id)
          },
          close,
        })
      },
    }),
  })

  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('weworkBrowser', service)
    return async () => {
      active = false
      unprovide()
      await Promise.allSettled([...cleanups].map(dispose => dispose()))
    }
  }, 'wework-browser-runtime: service generation')
}
