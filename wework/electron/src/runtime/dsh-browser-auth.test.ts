import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { Cookie, Session } from 'electron'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  copyDshBrowserAuthentication,
  DshBrowserAuthentication,
  dshBrowserAuthenticationCookies,
  dshBrowserRequestHeaders,
} from './dsh-browser-auth.js'

const owners: DshBrowserAuthentication[] = []

afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
})

describe('managed DSH authentication cookies', () => {
  test('reclaims only owned cookies in both sessions and preserves unknown DSH and site cookies', async () => {
    const source = browserSession()
    const target = browserSession()
    const firstUrl = 'http://127.0.0.1:41001/'
    const secondUrl = 'http://127.0.0.1:41002/'
    const first = owner(firstUrl)
    await first.prepare(source.session)
    source.add(authCookie(firstUrl))
    await first.refresh()
    await copyDshBrowserAuthentication(source.session, target.session, firstUrl)
    const unrelated = [
      ...Array.from({ length: 100 }, (_, index) =>
        authCookie(`http://127.0.0.1:${42000 + index}/`)
      ),
      { ...authCookie('http://example.test:41003/'), domain: 'example.test' },
      { ...authCookie('http://127.0.0.1:41004/'), path: '/other' },
      { ...authCookie(firstUrl), name: 'site-login' },
      { ...authCookie(firstUrl), name: 'dsh-auth-custom' },
    ]
    for (const session of [source, target]) {
      unrelated.forEach(cookie => session.add(cookie))
    }

    const second = owner(secondUrl)
    await second.prepare(source.session)
    source.add(authCookie(secondUrl))
    await second.refresh()
    await copyDshBrowserAuthentication(source.session, target.session, secondUrl)
    for (const session of [source, target]) {
      expect(session.all()).toEqual([authCookie(firstUrl), ...unrelated, authCookie(secondUrl)])
    }

    await first.dispose()
    for (const session of [source, target]) {
      expect(session.all()).toEqual([...unrelated, authCookie(secondUrl)])
    }
    expect(await dshBrowserAuthenticationCookies(source.session, secondUrl)).toEqual([
      authCookie(secondUrl),
    ])
    await second.dispose()
    expect(source.all()).toEqual(unrelated)
    expect(target.all()).toEqual(unrelated)
  })

  test('bounds real HTTP headers across 100 launches without deleting unknown cookies', async () => {
    const source = browserSession()
    const target = browserSession()
    for (let index = 0; index < 100; index++) {
      for (const session of [source, target]) {
        session.add(authCookie(`http://127.0.0.1:${43000 + index}/`))
      }
    }
    const server = createServer((_request, response) => response.end('ready'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server port')
    const status = (url: string, cookies: Cookie[]) =>
      new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(
          {
            host: '127.0.0.1',
            port: address.port,
            headers: dshBrowserRequestHeaders(url, {
              cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
            }),
          },
          response => {
            response.resume()
            response.on('end', () => resolve(response.statusCode))
          }
        )
        outgoing.on('error', reject)
        outgoing.end()
      })

    try {
      expect(await status('http://127.0.0.1:1/', source.all())).toBe(431)
      for (let index = 0; index < 100; index++) {
        const url = `http://127.0.0.1:${44000 + index}/`
        const authentication = owner(url)
        await authentication.prepare(source.session)
        expect(await status(url, source.all())).toBe(200)
        source.add(authCookie(url))
        await authentication.refresh()
        await copyDshBrowserAuthentication(source.session, target.session, url)
        expect(await status(url, target.all())).toBe(200)
        expect(target.all()).toHaveLength(101)
        await authentication.dispose()
        expect(source.all()).toHaveLength(100)
        expect(target.all()).toHaveLength(100)
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('serializes concurrent copies and cleanup without deleting another live runtime', async () => {
    const source = browserSession()
    const target = browserSession()
    const urls = ['http://127.0.0.1:45001/', 'http://127.0.0.1:45002/']
    const [first, second] = urls.map(url => owner(url))
    await Promise.all([first.prepare(source.session), second.prepare(source.session)])
    urls.forEach(url => source.add(authCookie(url)))
    await Promise.all([first.refresh(), second.refresh()])
    await Promise.all(
      urls.map(url => copyDshBrowserAuthentication(source.session, target.session, url))
    )
    await Promise.all([
      first.dispose(),
      copyDshBrowserAuthentication(source.session, target.session, urls[0]),
      copyDshBrowserAuthentication(source.session, target.session, urls[1]),
    ])
    expect(source.all()).toEqual([authCookie(urls[1])])
    expect(target.all()).toEqual([authCookie(urls[1])])
  })

  test('preserves a reused authority until every owner has stopped', async () => {
    const source = browserSession()
    const url = 'http://127.0.0.1:45003/'
    const first = owner(url)
    const second = owner(url)
    await first.prepare(source.session)
    source.add(authCookie(url))
    await first.refresh()
    await second.prepare(source.session)
    await second.refresh()
    await first.dispose()
    expect(source.all()).toEqual([authCookie(url)])
    await second.dispose()
    expect(source.all()).toEqual([])
  })

  test('propagates cleanup errors without blocking subsequent authentication', async () => {
    const source = browserSession()
    const url = 'http://127.0.0.1:45005/'
    const first = owner(url)
    await first.prepare(source.session)
    source.add(authCookie(url))
    await first.refresh()
    source.remove.mockRejectedValueOnce(new Error('cookie store unavailable'))
    await expect(first.dispose()).rejects.toThrow('DSH cookie cleanup failed')
    await first.dispose()
    await expect(owner('http://127.0.0.1:45006/').prepare(source.session)).resolves.toBeUndefined()
    expect(source.all()).toEqual([])
  })

  test.each([true, false])(
    'cleans the current credential when a reused authority rotates it (old owner stops first: %s)',
    async oldFirst => {
      const source = browserSession()
      const url = 'http://127.0.0.1:45013/'
      const first = owner(url)
      await first.prepare(source.session)
      source.add(authCookie(url))
      await first.refresh()
      const second = owner(url)
      await second.prepare(source.session)
      const replacement = { ...authCookie(url), value: 'rotated-session' }
      source.add(replacement)
      await second.refresh()

      await (oldFirst ? first : second).dispose()
      expect(source.all()).toEqual([replacement])
      await (oldFirst ? second : first).dispose()
      expect(source.all()).toEqual([])
    }
  )

  test('refreshes existing copied sessions after restart and reclaims an old authority', async () => {
    const source = browserSession()
    const target = browserSession()
    const firstUrl = 'http://127.0.0.1:45007/'
    const secondUrl = 'http://127.0.0.1:45008/'
    const authentication = owner(firstUrl)
    await authentication.prepare(source.session)
    source.add(authCookie(firstUrl))
    await authentication.refresh()
    await copyDshBrowserAuthentication(source.session, target.session, firstUrl)

    await authentication.prepare(source.session, secondUrl)
    const replacement = { ...authCookie(secondUrl), value: 'replacement-process-session' }
    source.add(replacement)
    await authentication.refresh()

    expect(source.all()).toEqual([replacement])
    expect(target.all()).toEqual([replacement])
    await authentication.dispose()
    expect(target.all()).toEqual([])
  })

  test('does not delete a cookie subsequently replaced by an independent session', async () => {
    const source = browserSession()
    const url = 'http://127.0.0.1:45009/'
    const authentication = owner(url)
    await authentication.prepare(source.session)
    source.add(authCookie(url))
    await authentication.refresh()
    const replacement = { ...authCookie(url), value: 'independent-session' }
    source.add(replacement)
    await authentication.dispose()
    expect(source.all()).toEqual([replacement])
  })

  test('keeps an independently authenticated DSH server usable after a managed runtime stops', async () => {
    const source = browserSession()
    const target = browserSession()
    const server = createServer((incoming, response) => {
      response.writeHead(
        incoming.headers.cookie === `${independent.name}=${independent.value}` ? 200 : 401
      )
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server port')
    const externalUrl = `http://127.0.0.1:${address.port}/`
    const independent = authCookie(externalUrl)
    target.add(independent)
    const url = `http://127.0.0.1:${address.port === 45012 ? 45013 : 45012}/`
    const authentication = owner(url)
    try {
      await authentication.prepare(source.session)
      source.add(authCookie(url))
      await authentication.refresh()
      await copyDshBrowserAuthentication(source.session, target.session, url)
      await authentication.dispose()
      expect(target.all()).toEqual([independent])
      const headers = dshBrowserRequestHeaders(externalUrl, {
        Cookie: target
          .all()
          .map(cookie => `${cookie.name}=${cookie.value}`)
          .join('; '),
      })
      const response = await fetch(externalUrl, { headers })
      await response.arrayBuffer()
      expect(response.status).toBe(200)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test.each(['Cookie', 'cookie', 'COOKIE'])(
    'filters only other DSH authority cookies on managed HTTP and WebSocket requests: %s',
    async header => {
      const source = browserSession()
      const url = 'http://127.0.0.1:45010/'
      const authentication = owner(url)
      await authentication.prepare(source.session)
      const own = authCookie(url)
      const foreign = authCookie('http://127.0.0.1:45011/')
      const headers = {
        [header]: `${foreign.name}=external; site-login=keep; ${own.name}=valid`,
        Accept: 'text/html',
      }
      for (const target of [url, url.replace('http:', 'ws:')]) {
        expect(dshBrowserRequestHeaders(target, headers)).toEqual({
          [header]: `site-login=keep; ${own.name}=valid`,
          Accept: 'text/html',
        })
      }
      for (const target of ['http://127.0.0.1:45011/', 'https://example.test/', 'not a URL']) {
        expect(dshBrowserRequestHeaders(target, headers)).toBe(headers)
      }
      expect(dshBrowserRequestHeaders(url, { [header]: `${foreign.name}=external` })).toEqual({})
      expect(headers[header]).toContain(foreign.name)
    }
  )
})

function owner(url: string): DshBrowserAuthentication {
  const authentication = new DshBrowserAuthentication(url)
  owners.push(authentication)
  return authentication
}

function authCookie(url: string): Cookie {
  return {
    name: `dsh-auth-${createHash('sha256').update(new URL(url).host).digest('base64url')}`,
    value: 'a'.repeat(173),
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
    session: false,
    sameSite: 'strict',
    expirationDate: 2_000_000_000,
  }
}

function browserSession() {
  const cookies = new Map<string, Cookie>()
  const key = (cookie: Cookie) => `${cookie.domain}|${cookie.path}|${cookie.name}`
  const add = (cookie: Cookie) => cookies.set(key(cookie), cookie)
  const remove = vi.fn(async (_url: string, name: string) => {
    for (const [key, cookie] of cookies) {
      if (cookie.domain === '127.0.0.1' && cookie.path === '/' && cookie.name === name) {
        cookies.delete(key)
      }
    }
  })
  const session = {
    cookies: {
      get: async (filter: { name?: string }) =>
        [...cookies.values()].filter(cookie => !filter.name || cookie.name === filter.name),
      set: async (details: { url: string; name: string; value: string }) => {
        const { url, ...attributes } = details
        add({ ...authCookie(url), ...attributes })
      },
      remove,
    },
  } as unknown as Session
  return { session, add, all: () => [...cookies.values()], remove }
}
