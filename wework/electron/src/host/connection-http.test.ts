import { expect, test, vi } from 'vitest'
import { fetchConnectionJson } from './connection-http.js'

test('connection HTTP sends read parameters through the supplied browser session', async () => {
  const fetch = vi.fn(async () => Response.json({ rows: [] }))
  await expect(
    fetchConnectionJson(fetch, 'https://posthog.example.test', {
      method: 'GET',
      path: '/project/12/results',
      query: { cursor: 'a&team=other' },
    })
  ).resolves.toEqual({ rows: [] })
  expect(fetch).toHaveBeenCalledWith(
    'https://posthog.example.test/project/12/results?cursor=a%26team%3Dother',
    expect.objectContaining({ credentials: 'include', redirect: 'manual' })
  )
})

test('the POST uses the current readable CSRF cookie for the approved URL', async () => {
  const fetch = vi.fn(async () => Response.json({ rows: [] }))
  const origin = 'https://posthog.example.test'
  const cookies = vi.fn(async () => [
    { name: 'session', value: 'session-secret', httpOnly: true },
    { name: 'posthog_csrftoken', value: 'rotated-token' },
  ])
  const csrf = { binding: { header: 'x-csrftoken', cookie: 'posthog_csrftoken' }, cookies } as const
  const query = { method: 'POST', path: '/query', json: { kind: 'Query' } } as const

  await fetchConnectionJson(fetch, origin, query, csrf)
  expect(cookies).toHaveBeenCalledWith(origin + '/query')
  expect(fetch).toHaveBeenCalledWith(
    origin + '/query',
    expect.objectContaining({
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin,
        'x-csrftoken': 'rotated-token',
      },
    })
  )
  cookies.mockResolvedValueOnce([{ name: 'posthog_csrftoken', value: 'secret', httpOnly: true }])
  await expect(fetchConnectionJson(fetch, origin, query, csrf)).rejects.toMatchObject({
    code: 'connector_auth_required',
  })
  expect(fetch).toHaveBeenCalledOnce()
})

test('connection HTTP rejects origin changes, normalized paths, redirects and sign-in pages', async () => {
  const origin = 'https://posthog.example.test'
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const path of ['//other.example.test/project/12', '/project/12/../13', '/project/12%2f13']) {
    await expect(fetchConnectionJson(fetch, origin, { method: 'GET', path })).rejects.toMatchObject(
      {
        code: 'invalid_connection_http',
      }
    )
  }
  expect(fetch).not.toHaveBeenCalled()

  const operation = { method: 'GET', path: '/project/12/results' } as const
  fetch.mockResolvedValueOnce(Response.redirect('https://login.example.test'))
  await expect(fetchConnectionJson(fetch, origin, operation)).rejects.toMatchObject({
    code: 'connection_http_redirect',
  })
  fetch.mockResolvedValueOnce(new Response('Signed out', { status: 401 }))
  await expect(fetchConnectionJson(fetch, origin, operation)).rejects.toMatchObject({
    code: 'connector_auth_required',
  })
  fetch.mockResolvedValueOnce(new Response('<html>Sign in</html>'))
  await expect(fetchConnectionJson(fetch, origin, operation)).rejects.toMatchObject({
    code: 'connection_response_invalid',
  })
})
