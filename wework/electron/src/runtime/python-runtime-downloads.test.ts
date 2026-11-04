import { afterEach, expect, test, vi } from 'vitest'
import { fetchPythonRuntimeDownloads } from './python-runtime-downloads.js'

const downloads = {
  uvDownloadBaseUrl: 'https://mirror.example.invalid/uv/0.9.5/',
  pythonInstallMirror: 'http://minio.example.invalid/bucket/python/',
}

afterEach(() => vi.useRealTimers())

test.each([
  ['https://backend.example.invalid', 'https://backend.example.invalid/api'],
  ['https://backend.example.invalid/subpath/api/', 'https://backend.example.invalid/subpath/api'],
])('loads public metadata from configured backend %s without credentials', async (backend, api) => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      web_url: 'https://web.example.invalid',
      socket_url: 'wss://socket.example.invalid',
      runtime_downloads: downloads,
    })
  )
  expect(
    await fetchPythonRuntimeDownloads({
      connection: async () => null,
      environment: { VITE_WEGENT_BACKEND_URL: backend },
      fetch,
    })
  ).toEqual(downloads)
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${api}/auth/wework/config`, {
    signal: expect.any(AbortSignal),
  })
})

test('uses the connected backend ahead of the launch and branded defaults', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ runtime_downloads: downloads }))
  await fetchPythonRuntimeDownloads({
    connection: async () => ({
      apiBaseUrl: 'https://connected.example.invalid/custom/api/',
      token: 'private',
    }),
    environment: { WEWORK_BACKEND_URL: 'https://launch.example.invalid' },
    backendUrl: 'https://brand.example.invalid',
    fetch,
  })
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://connected.example.invalid/custom/api/auth/wework/config',
    { signal: expect.any(AbortSignal) }
  )
})

test('uses branded backend before login and normalizes directory prefixes', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      runtime_downloads: {
        uvDownloadBaseUrl: ` ${downloads.uvDownloadBaseUrl.slice(0, -1)} `,
        pythonInstallMirror: downloads.pythonInstallMirror,
      },
    })
  )
  expect(
    await fetchPythonRuntimeDownloads({
      connection: async () => null,
      environment: {},
      backendUrl: 'https://brand.example.invalid',
      fetch,
    })
  ).toEqual(downloads)
  expect(fetch.mock.calls[0][0]).toBe('https://brand.example.invalid/api/auth/wework/config')
})

test.each([
  {},
  { runtime_downloads: {} },
  { runtime_downloads: { uvDownloadBaseUrl: downloads.uvDownloadBaseUrl } },
  { runtime_downloads: { ...downloads, uvDownloadBaseUrl: 'file:///tmp/uv' } },
  {
    runtime_downloads: {
      ...downloads,
      pythonInstallMirror: 'https://user:private@example.invalid/',
    },
  },
])(
  'rejects incomplete or unsafe metadata without falling back to a client source: %j',
  async payload => {
    const fetch = vi.fn().mockResolvedValue(Response.json(payload))
    await expect(
      fetchPythonRuntimeDownloads({
        connection: async () => null,
        environment: {},
        backendUrl: 'https://backend.example.invalid',
        fetch,
      })
    ).rejects.toThrow('Python download configuration: invalid')
    expect(fetch).toHaveBeenCalledOnce()
  }
)

test('rejects HTTP errors and malformed JSON without using the login request path', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('not json'))
  const options = {
    connection: async () => null,
    environment: {},
    backendUrl: 'https://backend.example.invalid',
    fetch,
  }
  await expect(fetchPythonRuntimeDownloads(options)).rejects.toThrow('HTTP 503')
  await expect(fetchPythonRuntimeDownloads(options)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each(['connection', 'headers', 'body'] as const)(
  'bounds stalled %s to 200ms and aborts even a signal-ignoring transport',
  async stage => {
    vi.useFakeTimers()
    const stalled = new Promise<never>(() => {})
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        stage === 'headers' ? stalled : { ok: true, json: () => stalled }
      )
    const pending = fetchPythonRuntimeDownloads({
      connection: async () => (stage === 'connection' ? stalled : null),
      environment: {},
      backendUrl: 'https://backend.example.invalid',
      fetch,
    })
    const rejected = expect(pending).rejects.toThrow('timed out after 200ms')
    await vi.advanceTimersByTimeAsync(199)
    if (stage !== 'connection') expect(fetch.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    if (stage === 'connection') expect(fetch).not.toHaveBeenCalled()
    else expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  }
)

test('accepts both download addresses arriving before the deadline', async () => {
  vi.useFakeTimers()
  const fetch = vi
    .fn()
    .mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve(Response.json({ runtime_downloads: downloads })), 199)
        )
    )
  const pending = fetchPythonRuntimeDownloads({
    connection: async () => null,
    environment: {},
    backendUrl: 'https://backend.example.invalid',
    fetch,
  })
  await vi.advanceTimersByTimeAsync(199)
  await expect(pending).resolves.toEqual(downloads)
  expect(vi.getTimerCount()).toBe(0)
})

test('does not reuse the previous backend metadata after switching backends', async () => {
  const connection = vi
    .fn()
    .mockResolvedValueOnce({ apiBaseUrl: 'https://first.example.invalid/api' })
    .mockResolvedValue({ apiBaseUrl: 'https://second.example.invalid/api' })
  const fetch = vi.fn().mockResolvedValue(Response.json({ runtime_downloads: downloads }))
  const options = { connection, environment: {}, fetch }
  await expect(fetchPythonRuntimeDownloads(options)).rejects.toThrow('Backend changed')
  fetch.mockResolvedValueOnce(Response.json({ runtime_downloads: downloads }))
  await expect(fetchPythonRuntimeDownloads(options)).resolves.toEqual(downloads)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://first.example.invalid/api/auth/wework/config',
    'https://second.example.invalid/api/auth/wework/config',
  ])
})
