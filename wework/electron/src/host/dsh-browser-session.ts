import type { Cookies, CookiesSetDetails } from 'electron'
import { parseSetCookie } from 'set-cookie-parser'

export async function installDshBrowserSession(
  store: Pick<Cookies, 'set'>,
  url: string,
  headers: string[]
): Promise<void> {
  const cookies = parseSetCookie(headers, { decodeValues: false })
  if (cookies.length === 0) throw new Error('DSH browser session authentication failed')
  await Promise.all(
    cookies.map(cookie => {
      const sameSite = cookie.sameSite?.toLowerCase()
      if (sameSite && !['strict', 'lax', 'none'].includes(sameSite)) {
        throw new Error('DSH browser session SameSite attribute is invalid')
      }
      const details: CookiesSetDetails = {
        url: new URL(url).origin,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite:
          sameSite === 'none' ? 'no_restriction' : (sameSite as 'strict' | 'lax' | undefined),
        expirationDate:
          cookie.maxAge !== undefined
            ? Date.now() / 1000 + cookie.maxAge
            : cookie.expires
              ? cookie.expires.getTime() / 1000
              : undefined,
      }
      return store.set(details)
    })
  )
}
