import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'

const activeScope = new AsyncLocalStorage<string>()

export function scopedMockUrl(base: string, scope: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope)) throw new Error('Invalid mock scope')
  return `${base.replace(/\/$/, '')}/e2e/${scope}`
}

export function mockRequestScope(request: Pick<IncomingMessage, 'url'>): string {
  const url = new URL(request.url || '/', 'http://mock-model')
  if (!url.pathname.startsWith('/e2e/')) return activeScope.getStore() || ''
  const match = /^\/e2e\/([a-zA-Z0-9_-]{1,128})(\/.*)$/.exec(url.pathname)
  if (!match) throw new Error('Invalid mock request scope')
  request.url = `${match[2]}${url.search}`
  return match[1]
}

export function withMockScope<T>(scope: string, action: () => T): T {
  return activeScope.run(scope, action)
}

/** Each HTTP request and its asynchronous descendants retain their own state. */
export class MockScopeStore<T> {
  private readonly scopes = new Map<string, T>()

  constructor(private readonly create: () => T) {}

  current(): T {
    const scope = activeScope.getStore() || ''
    let state = this.scopes.get(scope)
    if (state === undefined) {
      state = this.create()
      this.scopes.set(scope, state)
    }
    return state
  }
}
