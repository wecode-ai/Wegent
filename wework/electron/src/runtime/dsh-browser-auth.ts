import { createHash } from 'node:crypto'
import type { Cookie, Session } from 'electron'

const activeAuthentications = new Map<DshBrowserAuthentication, string>()
const AUTHENTICATION_COOKIE_NAME = /^dsh-auth-[A-Za-z0-9_-]{43}$/
let pendingMutation: Promise<unknown> = Promise.resolve()

/** Own authentication for a logical DSH runtime across supervised process restarts. */
export class DshBrowserAuthentication {
  private readonly targets = new Set<Session>()
  private readonly ownedCookies = new Map<Session, Map<string, string>>()
  private source: Session | null = null
  private disposed = false
  private disposal: Promise<void> | null = null

  constructor(private baseUrl: string) {
    if (!authenticationCookieName(baseUrl)) {
      throw new Error('DSH browser authentication requires IPv4 loopback HTTP')
    }
  }

  prepare(source: Session, baseUrl = this.baseUrl): Promise<void> {
    return mutateAuthentication(async () => {
      this.assertActive()
      const name = authenticationCookieName(baseUrl)
      if (!name) throw new Error('DSH browser authentication requires IPv4 loopback HTTP')
      this.baseUrl = baseUrl
      this.source = source
      activeAuthentications.set(this, name)
    })
  }

  refresh(): Promise<void> {
    return mutateAuthentication(async () => {
      this.assertActive()
      if (!this.source) throw new Error('DSH browser authentication has not been prepared')
      const cookies = await dshBrowserAuthenticationCookies(this.source, this.baseUrl)
      this.rememberCookies(this.source, cookies)
      for (const target of this.targets) {
        this.rememberCookies(target, cookies)
        await setAuthenticationCookies(target, this.baseUrl, cookies)
      }
      await this.reclaimCookies()
    })
  }

  trackCopy(target: Session, cookies: Cookie[]): void {
    this.targets.add(target)
    this.rememberCookies(target, cookies)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= mutateAuthentication(async () => {
      activeAuthentications.delete(this)
      await this.reclaimCookies()
      this.targets.clear()
      this.ownedCookies.clear()
    }).catch(error => {
      this.disposal = null
      throw error
    })
    return this.disposal
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('DSH browser authentication has been disposed')
  }

  private rememberCookies(target: Session, cookies: Cookie[]): void {
    const owned = this.ownedCookies.get(target) ?? new Map<string, string>()
    for (const cookie of cookies) owned.set(cookie.name, cookie.value)
    this.ownedCookies.set(target, owned)
  }

  private async reclaimCookies(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.ownedCookies].map(([target, owned]) => this.reclaimSessionCookies(target, owned))
    )
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'DSH cookie cleanup failed')
  }

  private async reclaimSessionCookies(target: Session, owned: Map<string, string>): Promise<void> {
    for (const [name, value] of owned) {
      const owners = [...activeAuthentications].filter(([, activeName]) => activeName === name)
      if (owners.some(([owner]) => owner === this)) continue
      // A matching name alone does not prove ownership of a subsequently replaced cookie.
      const url = 'http://127.0.0.1/'
      const cookies = await target.cookies.get({ url, name })
      if (
        cookies.some(
          cookie => cookie.domain === '127.0.0.1' && cookie.path === '/' && cookie.value === value
        )
      ) {
        if (owners.length) {
          for (const [owner] of owners) {
            const shared = owner.ownedCookies.get(target) ?? new Map<string, string>()
            shared.set(name, value)
            owner.ownedCookies.set(target, shared)
          }
        } else {
          await target.cookies.remove(url, name)
        }
      }
      owned.delete(name)
    }
  }
}

/** Copy only the requested authority's authentication and remember the destination for restarts. */
export async function copyDshBrowserAuthentication(
  source: Session,
  target: Session,
  baseUrl: string
): Promise<void> {
  await mutateAuthentication(async () => {
    const name = authenticationCookieName(baseUrl)
    const cookies = await dshBrowserAuthenticationCookies(source, baseUrl)
    // Track before writing so a partial copy is still reclaimed on final stop.
    for (const [owner, activeName] of activeAuthentications) {
      if (activeName === name) owner.trackCopy(target, cookies)
    }
    await setAuthenticationCookies(target, baseUrl, cookies)
  })
}

export async function dshBrowserAuthenticationCookies(source: Session, baseUrl: string) {
  const name = authenticationCookieName(baseUrl)
  if (!name) return []
  return source.cookies.get({ url: new URL(baseUrl).href, name })
}

/** Bound headers before Node's parser while preserving unknown cookies in Chromium storage. */
export function dshBrowserRequestHeaders(
  rawUrl: string,
  headers: Record<string, string>
): Record<string, string> {
  let name: string | null
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    name = authenticationCookieName(url.href)
  } catch {
    return headers
  }
  if (!name || ![...activeAuthentications.values()].includes(name)) return headers
  const next = { ...headers }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'cookie') continue
    const retained = value
      .split(';')
      .map(part => part.trim())
      .filter(part => {
        const cookieName = part.split('=', 1)[0]
        return !AUTHENTICATION_COOKIE_NAME.test(cookieName) || cookieName === name
      })
    if (retained.length) next[key] = retained.join('; ')
    else delete next[key]
  }
  return next
}

function authenticationCookieName(baseUrl: string): string | null {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null
  return `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
}

async function setAuthenticationCookies(target: Session, baseUrl: string, cookies: Cookie[]) {
  for (const cookie of cookies) {
    await target.cookies.set({
      url: new URL(baseUrl).href,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
    })
  }
}

function mutateAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation)
  // A failed cookie operation must not poison subsequent cleanup or authentication.
  pendingMutation = result.catch(() => undefined)
  return result
}
