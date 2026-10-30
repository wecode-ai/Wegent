import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeSessionConfig } from '@/services/backendConfig'
import { useWebIssueSession } from './useWebIssueSession'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const redirect = '/collaboration/12/issues/ISSUE-1?commentId=comment-1'
const bootstrapUrl = `https://wegent.example/mobile-web-session?${new URLSearchParams({ redirect })}`
const nonce = 'a'.repeat(64)
const config: RuntimeSessionConfig = {
  backendUrl: 'https://api.wegent.example',
  apiBaseUrl: 'https://api.wegent.example/api',
  socketBaseUrl: 'https://api.wegent.example',
  socketPath: '/socket.io',
  accessToken: 'native-token',
}
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  vi.unstubAllGlobals()
})

async function setup(loaded = true) {
  const deliver = vi.fn()
  let result!: ReturnType<typeof useWebIssueSession>
  function Harness() {
    result = useWebIssueSession(config, 6177, bootstrapUrl, deliver)
    return null
  }
  await act(async () => {
    renderer = create(<Harness />)
  })
  if (loaded) {
    await act(async () => result.finishPage(bootstrapUrl))
  }
  return { current: () => result, deliver }
}

function message(challenge = nonce): string {
  return JSON.stringify({ type: 'wework.web-session.request', nonce: challenge, redirect })
}

describe('Web Issue native session lifecycle', () => {
  const eventOrders = ['origin', 'full URL'].flatMap(source =>
    ['before load start', 'during loading', 'after load end'].map(timing => ({ source, timing }))
  )
  it.each(eventOrders)(
    'validates $source messages arriving $timing against the loaded native document',
    async ({ source, timing }) => {
      const fetcher = vi.fn(async () =>
        Response.json({ code: 'one-use', user_id: 6177, expires_at: Date.now() / 1000 + 60 })
      )
      vi.stubGlobal('fetch', fetcher)
      const hook = await setup(false)
      if (timing !== 'before load start') {
        act(() => hook.current().startPage(bootstrapUrl))
      }
      if (timing === 'after load end') {
        await act(async () => hook.current().finishPage(bootstrapUrl))
      }
      await act(async () => {
        await hook
          .current()
          .receiveMessage(message(), source === 'origin' ? 'https://wegent.example' : bootstrapUrl)
      })
      if (timing === 'before load start') {
        act(() => hook.current().startPage(bootstrapUrl))
      }
      if (timing !== 'after load end') {
        expect(fetcher).not.toHaveBeenCalled()
        await act(async () => hook.current().finishPage(bootstrapUrl))
      }
      expect(fetcher).toHaveBeenCalledOnce()
      expect(hook.deliver).toHaveBeenCalledOnce()
    }
  )

  it('does not trust an Android origin-only challenge from a different main document', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const hook = await setup(false)
    await act(async () => {
      await hook.current().receiveMessage(message(), 'https://wegent.example')
      await hook.current().finishPage('https://wegent.example/other')
      await hook.current().receiveMessage(message(), 'https://wegent.example')
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(hook.deliver).not.toHaveBeenCalled()
  })

  it('ignores external requests and issues one grant per page challenge', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ code: 'one-use', user_id: 6177, expires_at: Date.now() / 1000 + 60 })
    )
    vi.stubGlobal('fetch', fetcher)
    const hook = await setup()
    await act(async () => {
      await hook.current().receiveMessage(message(), 'https://evil.example/mobile-web-session')
    })
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => {
      await hook.current().receiveMessage(message(), bootstrapUrl)
      await hook.current().receiveMessage(message(), bootstrapUrl)
      await hook.current().receiveMessage(message('b'.repeat(64)), bootstrapUrl)
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(hook.deliver).toHaveBeenCalledOnce()
    expect(hook.current().errorStatus).toBeNull()
  })

  it('preserves expiry and denial status, and reload starts a new grant challenge', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ detail: 'Expired' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ code: 'recovered', user_id: 6177, expires_at: Date.now() / 1000 + 60 })
      )
    vi.stubGlobal('fetch', fetcher)
    const hook = await setup()
    await act(async () => {
      await hook.current().receiveMessage(message(), bootstrapUrl)
    })
    expect(hook.current().errorStatus).toBe(401)
    expect(hook.deliver).not.toHaveBeenCalled()
    act(() => hook.current().resetSession())
    await act(async () => {
      await hook.current().receiveMessage(message('b'.repeat(64)), bootstrapUrl)
      await hook.current().finishPage(bootstrapUrl)
    })
    expect(hook.current().errorStatus).toBeNull()
    expect(hook.deliver).toHaveBeenCalledOnce()
    await act(async () => {
      await hook
        .current()
        .receiveMessage(
          JSON.stringify({ type: 'wework.web-session.error', nonce, status: 409 }),
          bootstrapUrl
        )
    })
    expect(hook.current().errorStatus).toBeNull()
    await act(async () => {
      await hook
        .current()
        .receiveMessage(
          JSON.stringify({ type: 'wework.web-session.error', nonce: 'b'.repeat(64), status: 409 }),
          bootstrapUrl
        )
    })
    expect(hook.current().errorStatus).toBe(409)
  })

  it.each(['reload', 'unmount'])(
    'never injects an old grant after the WebView %s',
    async action => {
      let resolveResponse!: (response: Response) => void
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(resolve => (resolveResponse = resolve)))
      )
      const hook = await setup()
      let pending!: Promise<void>
      await act(async () => {
        pending = hook.current().receiveMessage(message(), bootstrapUrl)
      })
      act(() => {
        if (action === 'reload') hook.current().resetSession()
        else {
          renderer?.unmount()
          renderer = null
        }
      })
      await act(async () => {
        resolveResponse(
          Response.json({ code: 'stale', user_id: 6177, expires_at: Date.now() / 1000 + 60 })
        )
        await pending
      })
      expect(hook.deliver).not.toHaveBeenCalled()
    }
  )
})
