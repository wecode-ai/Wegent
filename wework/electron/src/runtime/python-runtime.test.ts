import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PythonRuntimeManager } from './python-runtime.js'

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
  test('exposes an isolated Python environment without changing the system PATH', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'runtime', 'bin')
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: { PATH: '/system/bin' },
      runtimeBin,
      platform: 'darwin',
      arch: 'arm64',
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
    })

    const environment = manager.environment()

    expect(environment.PATH).toBe(`${runtimeBin}:/system/bin`)
    expect(environment.WEWORK_RUNTIME_BIN).toBe(runtimeBin)
    expect(environment.WEGENT_PYTHON_PATH).toBe(join(runtimeBin, 'python3'))
    expect(environment.UV_PYTHON_BIN_DIR).toBe(runtimeBin)
    expect(environment.UV_MANAGED_PYTHON).toBe('true')
    expect(environment.UV_PYTHON_INSTALL_MIRROR_URL).toBe(
      'https://python-standalone.org/mirror/astral-sh/python-build-standalone/'
    )
    await expect(manager.status()).resolves.toMatchObject({
      id: 'python',
      managed: true,
      state: 'notInstalled',
      path: join(runtimeBin, 'python3'),
    })
  })

  test('installs Python once and validates the managed launcher', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'runtime', 'bin')
    const pythonPath = join(runtimeBin, 'python3')
    const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
    await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
      recursive: true,
    })
    await writeFile(uvPath, 'fake uv')
    let pythonReady = false
    const runFile = vi.fn(async (file: string, args: string[]) => {
      if (file === pythonPath && args[0] === '--version') {
        if (!pythonReady) throw new Error('missing')
        return { stdout: 'Python 3.12.8\n', stderr: '' }
      }
      if (file === uvPath) {
        expect(args).toEqual([
          '--no-config',
          '--no-progress',
          'python',
          'install',
          '--managed-python',
          '--default',
          '3.12',
        ])
        await mkdir(runtimeBin, { recursive: true })
        await writeFile(pythonPath, 'fake python')
        pythonReady = true
        return { stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected command: ${file}`)
    })
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      runtimeBin,
      platform: 'darwin',
      arch: 'arm64',
      runFile,
      fileSha256: vi
        .fn()
        .mockResolvedValue('d54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81'),
    })

    const [first, second] = await Promise.all([manager.ensure(), manager.ensure()])

    expect(first).toMatchObject({ state: 'installed', version: '3.12.8', path: pythonPath })
    expect(second).toEqual(first)
    expect(runFile.mock.calls.filter(([file]) => file === uvPath)).toHaveLength(1)
  })

  test('does not accept a later Python minor version as the managed runtime', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'runtime', 'bin')
    const pythonPath = join(runtimeBin, 'python3')
    await mkdir(runtimeBin, { recursive: true })
    await writeFile(pythonPath, 'fake python')
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      runtimeBin,
      platform: 'darwin',
      arch: 'arm64',
      runFile: vi.fn().mockResolvedValue({ stdout: 'Python 3.13.1\n', stderr: '' }),
    })

    await expect(manager.status()).resolves.toMatchObject({ state: 'notInstalled', version: null })
  })

  test('removes a corrupted cached uv executable before redownloading', async () => {
    const directory = await temporaryDirectory()
    const runtimeBin = join(directory, 'runtime', 'bin')
    const uvPath = join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5', 'uv')
    await mkdir(join(directory, 'managed-runtimes', 'python', 'bootstrap', 'uv-0.9.5'), {
      recursive: true,
    })
    await writeFile(uvPath, 'corrupted uv')
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      runtimeBin,
      platform: 'darwin',
      arch: 'arm64',
      fetch,
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
    })

    await expect(manager.ensure()).rejects.toThrow('uv archive size mismatch')
    await expect(access(uvPath)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('retains a verified download failure for diagnostics and retry', async () => {
    const directory = await temporaryDirectory()
    const manager = new PythonRuntimeManager({
      dataDirectory: directory,
      environment: {},
      runtimeBin: join(directory, 'runtime', 'bin'),
      platform: 'darwin',
      arch: 'arm64',
      fetch: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
      runFile: vi.fn().mockRejectedValue(new Error('missing')),
    })

    await expect(manager.ensure()).rejects.toThrow('uv archive size mismatch')
    await expect(manager.status()).resolves.toMatchObject({
      state: 'error',
      error: expect.stringContaining('uv archive size mismatch'),
    })
  })
})
