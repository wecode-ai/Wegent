import { createHash } from 'node:crypto'
import type { Session } from 'electron'

/** Copy one authority-bound DSH cookie to an isolated application session. */
export async function copyDshBrowserAuthentication(
  source: Session,
  target: Session,
  baseUrl: string
): Promise<void> {
  const url = new URL(baseUrl)
  const cookies = await dshBrowserAuthenticationCookies(source, baseUrl)
  for (const cookie of cookies) {
    await target.cookies.set({
      url: url.href,
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

export async function dshBrowserAuthenticationCookies(source: Session, baseUrl: string) {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return []
  const name = `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
  return source.cookies.get({ url: url.href, name })
}
