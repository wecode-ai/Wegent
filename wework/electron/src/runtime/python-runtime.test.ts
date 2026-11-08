import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PythonRuntimeManager } from './python-runtime.js'
import {
  fetchPythonRuntimeDownloads,
  PythonRuntimeLoginRequiredError,
} from './python-runtime-downloads.js'

const resolveDownloads = async () => ({
  uvUrl: 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-aarch64-apple-darwin.tar.gz',
  pythonUrl:
    'https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz',
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-python-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('PythonRuntimeManager', () => {
  test('waits for login without consuming the automatic attempt, then resumes only a demanded preparation', async () => {
    const directory = await temporaryDirectory()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new PythonRuntimeLoginRequiredError())
      .mockResolvedValue(await resolveDownloads())
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      resolveDownloads: load,
      hasPluginDemand: async () => true,
      fetch,
    })
    await expect(manager.resumeAfterLogin()).resolves.toMatchObject({ state: 'notInstalled' })
    expect(load).not.toHaveBeenCalled()
    await expect(manager.prewarm()).resolves.toMatchObject({ state: 'notInstalled', error: null })
    expect(fetch).not.toHaveBeenCalled()
    await expect(manager.resumeAfterLogin()).rejects.toThrow('uv archive size mismatch')
    expect(load).toHaveBeenCalledTimes(2)
    await expect(manager.resumeAfterLogin()).resolves.toMatchObject({ state: 'error' })
    await expect(manager.prewarm()).resolves.toMatchObject({ state: 'error' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['before', 'installed'],
    ['after', 'installed'],
    ['before', 'error'],
    ['after', 'error'],
  ] as const)(
    'resumes once when login arrives %s the old 401, with recovery ending in %s',
    async (loginOrder, recoveryState) => {
      const directory = await temporaryDirectory()
      const runtimeRoot = join(directory, 'managed-runtimes', 'python')
      const runtimeBin = join(runtimeRoot, 'bin')
      const pythonPath = join(runtimeBin, 'python3')
      const uvPath = join(runtimeRoot, 'bootstrap', 'uv-0.9.5', 'uv')
      await mkdir(join(runtimeRoot, 'bootstrap', 'uv-0.9.5'), { recursive: true })
      await mkdir(runtimeBin, { recursive: true })
      await writeFile(uvPath, 'cached uv fixture')
      let requestStarted!: () => void
      const started = new Promise<void>(resolve => (requestStarted = resolve))
      let finishOldRequest!: (response: Response) => void
      const oldResponse = new Promise<Response>(resolve => (finishOldRequest = resolve))
      let token = 'synthetic-old-token'
      const downloads = await resolveDownloads()
      const metadataFetch = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => {
          requestStarted()
          return oldResponse
        })
        .mockImplementation(async () =>
          recoveryState === 'installed'
            ? Response.json({
                uv: { version: '0.9.5', url: downloads.uvUrl },
                python: { version: '3.12.12', url: downloads.pythonUrl },
                expiresAt: null,
              })
            : new Response('', { status: 503 })
        )
      const load = vi.fn(() =>
        fetchPythonRuntimeDownloads({
          connection: async () => ({ apiBaseUrl: 'https://backend.example.invalid/api' }),
          accessToken: async () => token,
          fetch: metadataFetch,
          platform: 'darwin',
          arch: 'arm64',
        })
      )
      const artifactFetch = vi.fn()
      const manager = new PythonRuntimeManager({
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        resolveDownloads: load,
        hasPluginDemand: async () => true,
        fetch: artifactFetch,
        fileSha256: async () => 'd54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81',
        runFile: async file => {
          if (file === uvPath) {
            await writeFile(pythonPath, 'installed launcher fixture')
            return { stdout: '', stderr: '' }
          }
          if (file === pythonPath) return { stdout: 'Python 3.12.12', stderr: '' }
          throw new Error(`Unexpected command: ${file}`)
        },
      })
      const preparation = manager.prewarm()
      await started
      if (loginOrder === 'after') {
        finishOldRequest(new Response('', { status: 401 }))
        await expect(preparation).resolves.toMatchObject({ state: 'notInstalled' })
      }
      token = 'synthetic-new-token'
      const resumed = Promise.all([
        manager.resumeAfterLogin().catch(error => error),
        manager.resumeAfterLogin().catch(error => error),
      ])
      if (loginOrder === 'before') {
        finishOldRequest(new Response('', { status: 401 }))
        await preparation
      }
      for (const result of await resumed) {
        if (recoveryState === 'installed')
          expect(result).toMatchObject({ state: 'installed', version: '3.12.12' })
        else {
          expect(result).toBeInstanceOf(Error)
          expect(result.message).toContain('HTTP 503')
        }
      }
      expect(load).toHaveBeenCalledTimes(2)
      expect(metadataFetch).toHaveBeenCalledTimes(2)
      expect(metadataFetch.mock.calls.map(([, options]) => options?.headers)).toEqual([
        expect.objectContaining({ authorization: 'Bearer synthetic-old-token' }),
        expect.objectContaining({ authorization: 'Bearer synthetic-new-token' }),
      ])
      expect(artifactFetch).not.toHaveBeenCalled()
      await expect(manager.resumeAfterLogin()).resolves.toMatchObject({ state: recoveryState })
      await expect(manager.prewarm()).resolves.toMatchObject({ state: recoveryState })
      expect(load).toHaveBeenCalledTimes(2)
    }
  )

  test.each([false, true])(
    'redacts query credentials from download diagnostics (nested=%s)',
    async nested => {
      const directory = await temporaryDirectory()
      const log = vi.fn()
      const manager = new PythonRuntimeManager({
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        resolveDownloads,
        log,
        fetch: vi.fn().mockRejectedValue(
          nested
            ? new Error('Transport failed', {
                cause: new Error(
                  'https://mirror.example.invalid/uv.tar.gz?X-Amz-Signature=private-token'
                ),
              })
            : new Error(
                'Download https://mirror.example.invalid/uv.tar.gz?X-Amz-Signature=private-token failed'
              )
        ),
      })
      const failure = await manager.ensure().catch(error => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.cause).toBeUndefined()
      expect(String(failure)).not.toContain('private-token')
      const status = await manager.status()
      if (!nested) expect(status.error).toContain('?[redacted]')
      expect(JSON.stringify([status, log.mock.calls])).not.toContain('private-token')
    }
  )

  test('uses an installed Python offline without requesting download configuration', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
    await mkdir(runtimeBin, { recursive: true })
    const pythonPath = join(runtimeBin, 'python3')
    await writeFile(pythonPath, 'installed launcher')
    const resolveDownloads = vi.fn().mockRejectedValue(new Error('backend is offline'))
    const fetch = vi.fn()
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      resolveDownloads,
      fetch,
      runFile: vi.fn().mockResolvedValue({ stdout: 'Python 3.12.12', stderr: '' }),
    })
    await expect(manager.status()).resolves.toMatchObject({ state: 'installed' })
    await expect(manager.prewarm()).resolves.toMatchObject({ state: 'installed', path: pythonPath })
    await expect(manager.ensure()).resolves.toMatchObject({ state: 'installed', path: pythonPath })
    expect(resolveDownloads).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('configuration failure does not loop and manual retry requests fresh backend metadata', async () => {
    const directory = await temporaryDirectory()
    const resolveDownloads = vi
      .fn()
      .mockRejectedValueOnce(new Error('Python download configuration timed out after 200ms'))
      .mockResolvedValueOnce({
        uvUrl: 'https://new-backend.example.invalid/uv/uv-aarch64-apple-darwin.tar.gz',
        pythonUrl: 'https://new-backend.example.invalid/python/',
      })
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      resolveDownloads,
      fetch,
    })
    await expect(manager.prewarm()).rejects.toThrow('timed out after 200ms')
    await expect(manager.prewarm()).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('timed out after 200ms'),
    })
    expect(resolveDownloads).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    await expect(manager.ensure()).rejects.toThrow('uv archive size mismatch')
    expect(resolveDownloads).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://new-backend.example.invalid/uv/uv-aarch64-apple-darwin.tar.gz',
      { signal: expect.any(AbortSignal) }
    )
  })

  test.each([new Error('backend is offline'), new PythonRuntimeLoginRequiredError()])(
    'retains a usable older managed Python when downloads are unavailable: %s',
    async failure => {
      const directory = await temporaryDirectory()
      const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
      await mkdir(runtimeBin, { recursive: true })
      await writeFile(join(runtimeBin, 'python3'), 'installed launcher')
      const resolveDownloads = vi.fn().mockRejectedValue(failure)
      const fetch = vi.fn()
      const manager = new PythonRuntimeManager({
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        resolveDownloads,
        fetch,
        runFile: vi.fn().mockResolvedValue({ stdout: 'Python 3.12.8', stderr: '' }),
      })
      await expect(manager.ensure()).resolves.toMatchObject({
        state: 'installed',
        version: '3.12.8',
      })
      expect(resolveDownloads).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  test('does not install or change ordinary task environments before Python is requested', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: { PATH: '/system/bin', WEWORK_RUNTIME_BIN: '/node/bin' },
      platform: 'darwin',
      arch: 'arm64',
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
    })

    const environment = manager.environment()

    expect(environment.PATH).toBe('/system/bin')
    expect(environment.WEWORK_RUNTIME_BIN).toBe('/node/bin')
    expect(environment.WEGENT_PYTHON_PATH).toBe(join(runtimeBin, 'python3'))
    expect(environment.UV_PYTHON_BIN_DIR).toBeUndefined()
    expect(environment.UV_MANAGED_PYTHON).toBeUndefined()
    expect(environment.UV_PYTHON_INSTALL_MIRROR).toBeUndefined()
    expect(environment.PYTHONNOUSERSITE).toBeUndefined()
    await expect(manager.status()).resolves.toMatchObject({
      id: 'python',
      managed: true,
      state: 'notInstalled',
      path: join(runtimeBin, 'python3'),
    })
    await expect(access(join(directory, 'managed-runtimes', 'python'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test.each(['darwin', 'win32'] as const)(
    'preserves ordinary task Python import paths on %s',
    async platform => {
      const directory = await temporaryDirectory()
      const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
      const environment =
        platform === 'win32'
          ? {
              Path: 'C:\\Windows\\System32',
              PythonHome: 'C:\\OtherPython',
              PythonPath: 'C:\\OtherPackages',
              PythonUserBase: 'C:\\UserPackages',
              PythonNoUserSite: '0',
              PLUGIN_SETTING: 'preserved',
            }
          : {
              PATH: '/usr/bin',
              PYTHONHOME: '/other-python',
              PYTHONPATH: '/other-packages',
              PYTHONUSERBASE: '/user-packages',
              PYTHONNOUSERSITE: '0',
              PLUGIN_SETTING: 'preserved',
            }
      const original = { ...environment }
      const manager = new PythonRuntimeManager({
        resolveDownloads,
        dataDirectory: directory,
        environment,
        platform,
      })

      const prepared = manager.environment()

      expect(prepared).toEqual({
        ...original,
        WEGENT_PYTHON_PATH: join(runtimeBin, platform === 'win32' ? 'python.exe' : 'python3'),
      })
      expect(environment).toEqual(original)
    }
  )

  test.each([
    [
      'public GitHub artifact',
      'https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz',
    ],
    [
      'signed artifact',
      'https://mirror.example.invalid/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz?X-Amz-Signature=fixture%2Bsignature&X-Amz-Expires=900',
    ],
    [
      'configured Backend artifact',
      'https://python.example.invalid/releases/20251014/cpython-3.12.12%2B20251014-aarch64-apple-darwin-install_only_stripped.tar.gz',
    ],
  ])(
    'installs Python once and validates the managed launcher with %s',
    async (_name, expectedMirror) => {
      const directory = await temporaryDirectory()
      const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
      const pythonPath = join(runtimeBin, 'python3')
      const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
      await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
        recursive: true,
      })
      await writeFile(uvPath, 'fake uv')
      let pythonReady = false
      const onStatusChange = vi.fn()
      const resolveProxy = vi.fn().mockResolvedValue('http://proxy.internal:8080')
      const runFile = vi.fn(
        async (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          if (file === pythonPath && args[0] === '-I' && args[1] === '-c') {
            if (!pythonReady) throw new Error('missing')
            expect(args[2]).toContain('import ensurepip, ssl, sys, venv, zlib')
            expect(options.env.PYTHONNOUSERSITE).toBe('1')
            expect(options.env.PYTHONHOME).toBeUndefined()
            expect(options.env.PYTHONPATH).toBeUndefined()
            return { stdout: 'Python 3.12.12\n', stderr: '' }
          }
          if (file === uvPath) {
            expect(args).toEqual([
              '--native-tls',
              '--no-config',
              '--no-progress',
              'python',
              'install',
              '--force',
              '--managed-python',
              '--default',
              '3.12.12',
            ])
            expect(options.env).toMatchObject({
              UV_MANAGED_PYTHON: 'true',
              UV_PYTHON_BIN_DIR: runtimeBin,
              UV_PYTHON_DOWNLOADS_JSON_URL: expect.any(String),
              UV_PYTHON_INSTALL_DIR: join(directory, 'managed-runtimes', 'python', 'installations'),
              UV_CACHE_DIR: join(directory, 'managed-runtimes', 'python', 'cache'),
              HTTP_PROXY: 'http://proxy.internal:8080',
              HTTPS_PROXY: 'http://proxy.internal:8080',
              ALL_PROXY: 'http://proxy.internal:8080',
            })
            const index = JSON.parse(
              await readFile(options.env.UV_PYTHON_DOWNLOADS_JSON_URL!, 'utf8')
            )
            expect(index['cpython-3.12.12-darwin-aarch64-none']).toMatchObject({
              url: expectedMirror,
              sha256: '84cb7acbf75264982c8bdd818bfa1ff0f1eb76007b48a5f3e01d28633b46afdf',
            })
            expect(options.env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined()
            expect(options.env.UV_PYTHON_INSTALL_MIRROR_URL).toBeUndefined()
            expect(options.env.UV_OFFLINE).toBeUndefined()
            expect(options.env.UV_NO_MANAGED_PYTHON).toBeUndefined()
            expect(options.env.PYTHONHOME).toBeUndefined()
            expect(options.env.PYTHONPATH).toBeUndefined()
            await mkdir(runtimeBin, { recursive: true })
            await writeFile(pythonPath, 'fake python')
            pythonReady = true
            return { stdout: '', stderr: '' }
          }
          throw new Error(`Unexpected command: ${file}`)
        }
      )
      const manager = new PythonRuntimeManager({
        resolveDownloads: async () => ({
          uvUrl:
            'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-aarch64-apple-darwin.tar.gz',
          pythonUrl: expectedMirror,
        }),
        dataDirectory: directory,
        environment: {
          PYTHONHOME: '/external/python',
          PYTHONPATH: '/external/packages',
          UV_OFFLINE: '1',
          UV_NO_MANAGED_PYTHON: 'true',
          UV_PYTHON_INSTALL_DIR: '/user-python',
          UV_PYTHON_INSTALL_MIRROR: 'https://user-mirror.invalid/',
          UV_PYTHON_INSTALL_MIRROR_URL: 'https://incorrect-mirror.invalid/',
        },
        platform: 'darwin',
        arch: 'arm64',
        runFile,
        onStatusChange,
        resolveProxy,
        fileSha256: vi
          .fn()
          .mockResolvedValue('d54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81'),
      })

      const [first, second] = await Promise.all([manager.ensure(), manager.ensure()])

      expect(first).toMatchObject({ state: 'installed', version: '3.12.12', path: pythonPath })
      expect(second).toEqual(first)
      expect(onStatusChange.mock.calls.map(([status]) => [status.state, status.phase])).toEqual([
        ['downloading', 'install'],
        ['downloading', 'verify'],
        ['installed', null],
      ])
      expect(manager.environment()).toMatchObject({
        PYTHONHOME: '/external/python',
        PYTHONPATH: '/external/packages',
      })
      expect(runFile.mock.calls.filter(([file]) => file === uvPath)).toHaveLength(1)
      expect(resolveProxy).toHaveBeenCalledWith(expectedMirror)
      expect(await readdir(join(directory, 'managed-runtimes', 'python', 'temporary'))).toEqual([])
      await expect(manager.ensure()).resolves.toEqual(first)
      expect(runFile.mock.calls.filter(([file]) => file === uvPath)).toHaveLength(1)
    }
  )

  test('upgrades an older managed Python patch release', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
    const pythonPath = join(runtimeBin, 'python3')
    const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
    await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
      recursive: true,
    })
    await mkdir(runtimeBin, { recursive: true })
    await writeFile(uvPath, 'fake uv')
    await writeFile(pythonPath, 'fake python')
    let version = '3.12.8'
    const runFile = vi.fn(async (file: string, args: string[]) => {
      if (file === pythonPath && args[0] === '-I' && args[1] === '-c') {
        return { stdout: `Python ${version}\n`, stderr: '' }
      }
      if (file === uvPath) {
        version = '3.12.12'
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected command: ${file}`)
    })
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      runFile,
      fileSha256: vi
        .fn()
        .mockResolvedValue('d54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81'),
    })

    await expect(manager.ensure()).resolves.toMatchObject({
      state: 'installed',
      version: '3.12.12',
    })
    expect(runFile.mock.calls.filter(([file]) => file === uvPath)).toHaveLength(1)
  })

  test.each(['3.12.8', '3.12.12'])(
    'returns the revalidated %s launcher after a patch upgrade fails',
    async remainingVersion => {
      const directory = await temporaryDirectory()
      const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
      const pythonPath = join(runtimeBin, 'python3')
      const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
      await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
        recursive: true,
      })
      await mkdir(runtimeBin, { recursive: true })
      await writeFile(uvPath, 'fake uv')
      await writeFile(pythonPath, 'fake python')
      const log = vi.fn()
      let version = '3.12.8'
      const runFile = vi.fn(async (file: string, args: string[]) => {
        if (file === pythonPath && args[0] === '-I' && args[1] === '-c') {
          return { stdout: `Python ${version}\n`, stderr: '' }
        }
        if (file === uvPath) {
          version = remainingVersion
          throw new Error('installation command failed')
        }
        throw new Error(`Unexpected command: ${file}`)
      })
      const manager = new PythonRuntimeManager({
        resolveDownloads,
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        runFile,
        fileSha256: vi
          .fn()
          .mockResolvedValue('d54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81'),
        log,
      })

      await expect(manager.ensure()).resolves.toMatchObject({
        state: 'installed',
        version: remainingVersion,
      })
      expect(runFile.mock.calls.filter(([file]) => file === pythonPath)).toHaveLength(2)
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'python-runtime-upgrade-failed',
          currentVersion: remainingVersion,
          targetVersion: '3.12.12',
        })
      )
    }
  )

  test.each(['corrupted', 'removed'])(
    'rejects a %s launcher after an upgrade and allows repair on retry',
    async failure => {
      const directory = await temporaryDirectory()
      const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
      const pythonPath = join(runtimeBin, 'python3')
      const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
      await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
        recursive: true,
      })
      await mkdir(runtimeBin, { recursive: true })
      await writeFile(uvPath, 'fake uv')
      await writeFile(pythonPath, 'old launcher')
      let version = '3.12.8'
      let installAttempts = 0
      const runFile = vi.fn(async (file: string, args: string[]) => {
        if (file === pythonPath && args[0] === '-I' && args[1] === '-c') {
          if (!version) throw new Error('ModuleNotFoundError: No module named _ssl')
          return { stdout: `Python ${version}\n`, stderr: '' }
        }
        if (file === uvPath) {
          installAttempts += 1
          if (installAttempts === 1) {
            version = ''
            if (failure === 'removed') await rm(pythonPath)
            else await writeFile(pythonPath, 'broken replacement')
          } else {
            version = '3.12.12'
            await writeFile(pythonPath, 'repaired launcher')
          }
          return { stdout: '', stderr: '' }
        }
        throw new Error(`Unexpected command: ${file}`)
      })
      const manager = new PythonRuntimeManager({
        resolveDownloads,
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        runFile,
        fileSha256: vi
          .fn()
          .mockResolvedValue('d54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81'),
      })

      await expect(manager.ensure()).rejects.toThrow('without a usable launcher')
      await expect(manager.status()).resolves.toMatchObject({ state: 'error', version: null })
      await expect(manager.ensure()).resolves.toMatchObject({
        state: 'installed',
        version: '3.12.12',
      })
      expect(installAttempts).toBe(2)
    }
  )

  test('does not accept a later Python minor version as the managed runtime', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
    const pythonPath = join(runtimeBin, 'python3')
    await mkdir(runtimeBin, { recursive: true })
    await writeFile(pythonPath, 'fake python')
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      runFile: vi.fn().mockResolvedValue({ stdout: 'Python 3.13.1\n', stderr: '' }),
    })

    await expect(manager.status()).resolves.toMatchObject({ state: 'notInstalled', version: null })
  })

  test('rejects a version-compatible Python when its required standard library cannot load', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'managed-runtimes', 'python', 'bin')
    const pythonPath = join(runtimeBin, 'python3')
    await mkdir(runtimeBin, { recursive: true })
    await writeFile(pythonPath, 'fake python')
    const runFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12.12\n', stderr: '' }
      throw new Error('ModuleNotFoundError: No module named _ssl')
    })
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      runFile,
    })

    await expect(manager.status()).resolves.toMatchObject({ state: 'notInstalled', version: null })
    expect(runFile).toHaveBeenCalledWith(
      pythonPath,
      ['-I', '-c', expect.stringContaining('import ensurepip, ssl, sys, venv, zlib')],
      expect.objectContaining({ env: expect.objectContaining({ PYTHONNOUSERSITE: '1' }) })
    )
  })

  test.each([
    [
      'public backend source',
      undefined,
      'https://github.com/astral-sh/uv/releases/download/0.9.5/',
    ],
    [
      'public backend source with slash',
      'https://github.com/astral-sh/uv/releases/download/0.9.5/',
      'https://github.com/astral-sh/uv/releases/download/0.9.5/',
    ],
    ['internal backend source', ' https://uv.example.com/0.9.5 ', 'https://uv.example.com/0.9.5/'],
    ['trailing slash', 'https://uv.example.com/0.9.5/', 'https://uv.example.com/0.9.5/'],
  ])(
    'removes a corrupted cached uv executable before redownloading from %s',
    async (_name, _sourceValue, expectedBaseUrl) => {
      const directory = await temporaryDirectory()
      const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
      await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
        recursive: true,
      })
      await writeFile(uvPath, 'corrupted uv')
      const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
      const manager = new PythonRuntimeManager({
        resolveDownloads: async () => ({
          uvUrl: `${expectedBaseUrl}uv-aarch64-apple-darwin.tar.gz`,
          pythonUrl: 'https://github.com/astral-sh/python-build-standalone/releases/download/',
        }),
        dataDirectory: directory,
        environment: {},
        platform: 'darwin',
        arch: 'arm64',
        fetch,
        runFile: vi.fn().mockRejectedValue(new Error('missing')),
      })

      await expect(manager.ensure()).rejects.toThrow('uv archive size mismatch')
      await expect(access(uvPath)).rejects.toThrow()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith(`${expectedBaseUrl}uv-aarch64-apple-darwin.tar.gz`, {
        signal: expect.any(AbortSignal),
      })
    }
  )

  test('retains a verified download failure for diagnostics and retry', async () => {
    const directory = await temporaryDirectory()
    const log = vi.fn()
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      fetch: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
      log,
    })

    await expect(manager.ensure()).rejects.toThrow('uv archive size mismatch')
    await expect(manager.status()).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('uv archive size mismatch'),
    })
    expect(log).toHaveBeenCalledWith({
      event: 'python-runtime-uv-prepare-failed',
      stage: 'download',
      downloadedBytes: 3,
      totalBytes: 18_341_942,
    })
    expect(log.mock.calls.map(([event]) => event.event)).toEqual([
      'python-runtime-ensure-started',
      'python-runtime-uv-prepare-started',
      'python-runtime-uv-download-started',
      'python-runtime-uv-download-failed',
      'python-runtime-uv-prepare-failed',
      'python-runtime-install-failed',
    ])
  })

  test('aborts a stalled response body and removes its partial uv download', async () => {
    const directory = await temporaryDirectory()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      cancel,
    })
    // This real stream deliberately ignores the fetch signal and never closes.
    // The pipeline must enforce the deadline after response headers arrive.
    const fetch = vi.fn().mockResolvedValue(new Response(body))
    const log = vi.fn()
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      fetch,
      downloadTimeoutMs: 10,
      log,
    })

    await expect(manager.ensure()).rejects.toThrow('uv download timed out after 10ms')

    expect(cancel).toHaveBeenCalledOnce()
    expect(await readdir(join(directory, 'managed-runtimes', 'python', 'temporary'))).toEqual([])
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'python-runtime-uv-download-failed', timedOut: true })
    )
    await expect(manager.status()).resolves.toMatchObject({
      state: 'error',
      error: 'uv download timed out after 10ms',
    })
  })

  test('aborts a stalled uv download after the bounded timeout', async () => {
    const directory = await temporaryDirectory()
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        })
    )
    const manager = new PythonRuntimeManager({
      resolveDownloads,
      dataDirectory: directory,
      environment: {},
      platform: 'darwin',
      arch: 'arm64',
      fetch,
      downloadTimeoutMs: 10,
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
    })

    await expect(manager.ensure()).rejects.toThrow('uv download timed out after 10ms')
    expect(fetch).toHaveBeenCalledWith(expect.any(String), {
      signal: expect.any(AbortSignal),
    })
  })
})
