import { afterEach, expect, test, vi } from 'vitest'
import { pythonArtifact } from './python-runtime-artifacts.js'
import {
  fetchPythonRuntimeDownloads,
  fetchParentPythonRuntimeDownloads,
  PythonRuntimeLoginRequiredError,
} from './python-runtime-downloads.js'

const downloads = {
  uvUrl:
    'https://mirror.example.invalid/uv/uv-aarch64-apple-darwin.tar.gz?X-Amz-Signature=synthetic%2Fsignature&x=1',
  pythonUrl:
    'https://mirror.example.invalid/python/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz?X-Amz-Signature=synthetic%2Bsignature',
}
const payload = () => ({
  uv: { version: '0.9.5', url: downloads.uvUrl },
  python: { version: '3.12.12', url: downloads.pythonUrl },
  expiresAt: null,
})
function options(fetch = vi.fn().mockImplementation(async () => Response.json(payload()))) {
  return {
    connection: vi.fn().mockResolvedValue({
      apiBaseUrl: 'https://backend.example.invalid/custom/api/',
      credentialMode: 'desktop_refresh',
    }),
    accessToken: vi.fn().mockResolvedValue('synthetic-login-token'),
    fetch,
    platform: 'darwin',
    arch: 'arm64',
  }
}

function parentDownloads(platform = process.platform, arch: string = process.arch) {
  const targets: Partial<Record<NodeJS.Platform, string>> = {
    darwin: 'apple-darwin',
    linux: 'unknown-linux-gnu',
    win32: 'pc-windows-msvc',
  }
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${targets[platform]}`
  return {
    uvUrl: `https://mirror.example.invalid/uv-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}?signature=synthetic%2Bvalue`,
    pythonUrl: `https://mirror.example.invalid/${pythonArtifact(platform, arch).filename}?signature=synthetic%2Bvalue`,
  }
}

afterEach(() => vi.useRealTimers())

test('only the authenticated descriptor request carries the login token and returns exact signed URLs', async () => {
  const input = options()
  await expect(fetchPythonRuntimeDownloads(input)).resolves.toEqual(downloads)
  expect(input.accessToken).toHaveBeenCalledWith(
    'https://backend.example.invalid/custom/api',
    expect.objectContaining({ credentialMode: 'desktop_refresh' })
  )
  expect(input.fetch).toHaveBeenCalledExactlyOnceWith(
    'https://backend.example.invalid/custom/api/wework/runtime-downloads',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-login-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        platform: 'darwin',
        arch: 'arm64',
        uvVersion: '0.9.5',
        pythonVersion: '3.12.12',
      }),
      signal: expect.any(AbortSignal),
    }
  )
})

test('does not issue any request or refresh credentials before login', async () => {
  const input = options()
  input.connection.mockResolvedValue(null)
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toBeInstanceOf(
    PythonRuntimeLoginRequiredError
  )
  expect(input.fetch).not.toHaveBeenCalled()
  expect(input.accessToken).not.toHaveBeenCalled()
})

test('missing or expired login credentials fail without requesting a public fallback', async () => {
  const input = options()
  input.accessToken.mockResolvedValue('')
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toBeInstanceOf(
    PythonRuntimeLoginRequiredError
  )
  expect(input.fetch).not.toHaveBeenCalled()
  input.accessToken.mockResolvedValue('token')
  input.fetch.mockResolvedValueOnce(new Response('', { status: 401 }))
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toBeInstanceOf(
    PythonRuntimeLoginRequiredError
  )
  expect(input.fetch).toHaveBeenCalledOnce()
})

test.each([
  {},
  { uv: { version: '0.9.5', url: downloads.uvUrl } },
  { ...payload(), uv: { version: '0.9.6', url: downloads.uvUrl } },
  { ...payload(), python: { version: '3.12.12', url: 'file:///private/python.tar.gz' } },
  {
    ...payload(),
    python: { version: '3.12.12', url: 'https://user:secret@example.invalid/python.tar.gz' },
  },
  {
    ...payload(),
    python: { version: '3.12.12', url: 'https://example.invalid/wrong-artifact.tar.gz' },
  },
  { ...payload(), expiresAt: '2000-01-01T00:00:00Z' },
  { ...payload(), expiresAt: 'invalid-date' },
])('rejects incomplete, expired or unsafe artifacts without a fallback: %j', async body => {
  const input = options(vi.fn().mockResolvedValue(Response.json(body)))
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toThrow('Python download configuration:')
  expect(input.fetch).toHaveBeenCalledOnce()
})

test('rejects HTTP errors and malformed JSON without returning or logging response content', async () => {
  const input = options(
    vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('not-json-private'))
  )
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toThrow('HTTP 503')
  await expect(fetchPythonRuntimeDownloads(input)).rejects.toThrow(
    'Python download configuration: invalid response'
  )
  expect(input.fetch).toHaveBeenCalledTimes(2)
})

test.each(['headers', 'body'] as const)(
  'bounds stalled %s to 200ms even if the transport ignores cancellation',
  async stage => {
    vi.useFakeTimers()
    const stalled = new Promise<never>(() => {})
    const input = options(
      vi
        .fn()
        .mockImplementation(async () =>
          stage === 'headers' ? stalled : { ok: true, json: () => stalled }
        )
    )
    const pending = fetchPythonRuntimeDownloads(input)
    const rejected = expect(pending).rejects.toThrow(
      `timed out after 200ms; phase=${stage}, elapsedMs=200, phaseElapsedMs=200`
    )
    await vi.advanceTimersByTimeAsync(199)
    expect(input.fetch.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(input.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  }
)

test('distinguishes a stalled backend identity check from stalled HTTP transport', async () => {
  vi.useFakeTimers()
  const input = options()
  input.connection
    .mockResolvedValueOnce({ apiBaseUrl: 'https://backend.example.invalid/custom/api/' })
    .mockResolvedValueOnce({ apiBaseUrl: 'https://backend.example.invalid/custom/api/' })
    .mockImplementationOnce(() => new Promise(() => {}))
  const pending = fetchPythonRuntimeDownloads(input)
  const rejected = expect(pending).rejects.toThrow('phase=backend-check')
  await vi.advanceTimersByTimeAsync(200)
  await rejected
  expect(input.fetch.mock.calls[0][1].signal.aborted).toBe(true)
})

test('accepts both artifact addresses arriving before the deadline and clears its timer', async () => {
  vi.useFakeTimers()
  const input = options(
    vi
      .fn()
      .mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(Response.json(payload())), 199))
      )
  )
  const pending = fetchPythonRuntimeDownloads(input)
  await vi.advanceTimersByTimeAsync(199)
  await expect(pending).resolves.toEqual(downloads)
  expect(vi.getTimerCount()).toBe(0)
})

test('does not shorten the existing credential refresh budget to 200ms', async () => {
  vi.useFakeTimers()
  const input = options()
  input.accessToken.mockImplementation(
    () => new Promise(resolve => setTimeout(() => resolve('token'), 500))
  )
  const pending = fetchPythonRuntimeDownloads(input)
  await vi.advanceTimersByTimeAsync(499)
  expect(input.fetch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toEqual(downloads)
})

test('rejects a backend switch during either credential resolution or the descriptor request', async () => {
  for (const changeAt of [1, 2]) {
    const input = options()
    let call = 0
    input.connection.mockImplementation(async () => ({
      apiBaseUrl: `https://${call++ >= changeAt ? 'second' : 'first'}.example.invalid/api`,
    }))
    await expect(fetchPythonRuntimeDownloads(input)).rejects.toThrow('Backend changed')
    expect(input.fetch).toHaveBeenCalledTimes(changeAt === 1 ? 0 : 1)
  }
})

test('development child receives full addresses via a Python-only loopback capability', async () => {
  const hostDownloads = parentDownloads()
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: hostDownloads }))
  const environment = {
    WEWORK_PARENT_PYTHON_DOWNLOADS_URL: 'http://127.0.0.1:1234/runtime/python/downloads',
    WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN: 'synthetic-python-capability',
  }
  await expect(fetchParentPythonRuntimeDownloads(environment, fetch)).resolves.toEqual(
    hostDownloads
  )
  expect(fetch).toHaveBeenCalledExactlyOnceWith(environment.WEWORK_PARENT_PYTHON_DOWNLOADS_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-python-capability' },
    signal: expect.any(AbortSignal),
  })
  fetch.mockResolvedValueOnce(Response.json({ ok: false, code: 'python_runtime_login_required' }))
  await expect(fetchParentPythonRuntimeDownloads(environment, fetch)).rejects.toBeInstanceOf(
    PythonRuntimeLoginRequiredError
  )
  await expect(
    fetchParentPythonRuntimeDownloads(
      {
        ...environment,
        WEWORK_PARENT_PYTHON_DOWNLOADS_URL:
          'https://external.example.invalid/runtime/python/downloads',
      },
      fetch
    )
  ).rejects.toThrow('Invalid parent')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each([
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
] as const)(
  'validates parent artifacts against the declared %s-%s target',
  async (platform, arch) => {
    const expected = parentDownloads(platform, arch)
    const request = vi.fn(async () => Response.json({ ok: true, data: expected }))
    const environment = {
      WEWORK_PARENT_PYTHON_DOWNLOADS_URL: 'http://127.0.0.1:1234/runtime/python/downloads',
      WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN: 'synthetic-python-capability',
    }
    await expect(
      fetchParentPythonRuntimeDownloads(environment, request, platform, arch)
    ).resolves.toEqual(expected)
    const otherPlatform = platform === 'darwin' ? 'linux' : 'darwin'
    await expect(
      fetchParentPythonRuntimeDownloads(environment, request, otherPlatform, arch)
    ).rejects.toThrow('invalid uvUrl artifact')
  }
)
