import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { WorkbenchDshLaunch } from '../runtime/workbench-dsh-runtime.js'
import {
  verifySmartAppRuntime,
  type SmartAppRuntimeVerifierDependencies,
} from './smart-app-runtime-verifier.js'
import type { SmartAppVerificationContract } from './smart-app-verification-types.js'
import { copySmartAppDeliveryFiles } from './smart-app-package-validator.js'

describe('verifySmartAppRuntime', () => {
  test('requests OS-assigned ports and probes each started runtime address in an isolated home', async () => {
    const prepared: Array<{ dataDirectory: string; port: number; environment: NodeJS.ProcessEnv }> =
      []
    const stop = vi.fn().mockResolvedValue(undefined)
    const runCommand = vi.fn().mockResolvedValue(undefined)
    const verifyPage = vi.fn().mockResolvedValue({ issues: [] })
    const runProbe = vi.fn().mockResolvedValue({ issues: [] })
    let nextPort = 41001
    const dependencies = fixtureDependencies({
      prepareLaunch: async options => {
        prepared.push({
          dataDirectory: options.dataDirectory,
          port: options.port,
          environment: options.environment,
        })
        return launch(options.dataDirectory, options.port)
      },
      createRuntime: runtimeOptions => {
        expect(runtimeOptions.url).toBe('http://127.0.0.1:0/')
        expect(runtimeOptions.args?.slice(-2)).toEqual(['--port', '0'])
        const baseUrl = `http://127.0.0.1:${nextPort++}/`
        let started = false
        return {
          start: vi.fn(async () => {
            started = true
          }),
          url: () => {
            expect(started).toBe(true)
            return baseUrl
          },
          stop,
        }
      },
      runCommand,
      verifyPage,
      runProbe,
    })

    await expect(verifySmartAppRuntime(options(), dependencies)).resolves.toEqual({ issues: [] })
    await expect(verifySmartAppRuntime(options(), dependencies)).resolves.toEqual({ issues: [] })

    expect(prepared).toHaveLength(2)
    expect(prepared[0]?.dataDirectory).not.toBe(prepared[1]?.dataDirectory)
    expect(prepared.map(item => item.port)).toEqual([0, 0])
    expect(runCommand.mock.calls[0]?.[1]).toContain('--dump-config')
    for (const [index, baseUrl] of [
      'http://127.0.0.1:41001/',
      'http://127.0.0.1:41002/',
    ].entries()) {
      expect(verifyPage).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          baseUrl,
          path: '/',
          readySelector: '[data-testid="smart-app-ready"]',
        })
      )
      expect(runProbe).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({ baseUrl }))
    }
    expect(stop).toHaveBeenCalledTimes(2)
    for (const item of prepared) {
      await expect(stat(item.dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  test('does not pass personal DSH or Wework credentials into the isolated verifier', async () => {
    let verificationEnvironment: NodeJS.ProcessEnv = {}
    const dependencies = fixtureDependencies({
      prepareLaunch: async options => {
        verificationEnvironment = options.environment
        return launch(options.dataDirectory, options.port)
      },
    })

    await verifySmartAppRuntime(
      options({
        environment: {
          PATH: '/managed/bin',
          WEWORK_NODE_PATH: '/managed/node',
          WEWORK_HARNESS_RESOURCE_ROOT: '/managed/harness-runtime',
          DSH_HOME: '/personal/dsh',
          WEWORK_ELECTRON_HOST_TOKEN: 'host-secret',
          WEWORK_EXECUTOR_TOKEN: 'executor-secret',
          WEWORK_HARNESS_CONTEXT_TOKEN: 'context-secret',
          DSH_CREDENTIALS_PATH: '/personal/credentials.yaml',
        },
      }),
      dependencies
    )

    expect(verificationEnvironment).toMatchObject({
      PATH: '/managed/bin',
      WEWORK_NODE_PATH: '/managed/node',
      WEWORK_HARNESS_RESOURCE_ROOT: '/managed/harness-runtime',
    })
    expect(verificationEnvironment).not.toHaveProperty('DSH_HOME')
    expect(verificationEnvironment).not.toHaveProperty('WEWORK_ELECTRON_HOST_TOKEN')
    expect(verificationEnvironment).not.toHaveProperty('WEWORK_EXECUTOR_TOKEN')
    expect(verificationEnvironment).not.toHaveProperty('WEWORK_HARNESS_CONTEXT_TOKEN')
    expect(verificationEnvironment).not.toHaveProperty('DSH_CREDENTIALS_PATH')
  })

  test.each([
    ['0.1.0-rc.8', '"1"'],
    ['0.2.0-rc.2', '1'],
  ])('creates private credentials for DSH %s with schema version %s', async (dsh, version) => {
    let credentials = ''
    let credentialsMode = 0
    const dependencies = fixtureDependencies({
      prepareLaunch: async options => {
        const path = `${options.dataDirectory}/harness-apps/instances/verification/.credentials.yaml`
        credentials = await readFile(path, 'utf8')
        credentialsMode = (await stat(path)).mode & (process.platform === 'win32' ? 0o600 : 0o777)
        return launch(options.dataDirectory, options.port)
      },
    })

    const input = options()
    input.manifest.requirements.dsh = dsh
    await verifySmartAppRuntime(input, dependencies)

    expect(credentials).toBe(`version: ${version}\n`)
    expect(credentialsMode).toBe(0o600)
  })

  test('copies only delivery-safe files into the isolated runtime', async () => {
    const source = await mkdtemp(join(tmpdir(), 'wework-smart-app-runtime-source-'))
    await mkdir(join(source, 'package'))
    await writeFile(join(source, 'plugin-manifest.json'), '{}\n')
    await writeFile(join(source, 'package', 'index.js'), 'export {}\n')
    await writeFile(join(source, 'smart-app.verify.json'), '{}\n')
    await writeFile(join(source, '.env.local'), 'TOKEN=secret\n')
    let copiedProject = ''
    let copiedSecret = true
    let copiedContract = true
    const dependencies = fixtureDependencies({
      copyProject: copySmartAppDeliveryFiles,
      prepareLaunch: async options => {
        copiedProject = options.packagePath
        copiedSecret = await exists(join(copiedProject, '.env.local'))
        copiedContract = await exists(join(copiedProject, 'smart-app.verify.json'))
        return launch(options.dataDirectory, options.port)
      },
    })

    try {
      await verifySmartAppRuntime(options({ projectRoot: source }), dependencies)
      expect(copiedProject).not.toBe(source)
      expect(copiedSecret).toBe(false)
      expect(copiedContract).toBe(false)
      await expect(readFile(join(source, '.env.local'), 'utf8')).resolves.toContain('secret')
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  test.each(['start', 'page', 'probe'] as const)(
    'stops the runtime and removes temporary state after a %s failure',
    async failure => {
      let temporaryRoot = ''
      const stop = vi.fn().mockResolvedValue(undefined)
      const dependencies = fixtureDependencies({
        prepareLaunch: async options => {
          temporaryRoot = options.dataDirectory
          return launch(options.dataDirectory, options.port)
        },
        createRuntime: () => ({
          url: () => 'http://127.0.0.1:41001/',
          start:
            failure === 'start'
              ? vi.fn().mockRejectedValue(new Error('start failed'))
              : vi.fn().mockResolvedValue(undefined),
          stop,
        }),
        verifyPage: vi
          .fn()
          .mockResolvedValue(
            failure === 'page'
              ? { issues: [runtimeIssue('SA-RUNTIME-READY-TIMEOUT')] }
              : { issues: [] }
          ),
        runProbe: vi
          .fn()
          .mockResolvedValue(
            failure === 'probe' ? { issues: [runtimeIssue('SA-RUNTIME-PROBE')] } : { issues: [] }
          ),
      })

      const result = await verifySmartAppRuntime(options(), dependencies)

      expect(result.issues).not.toEqual([])
      expect(stop).toHaveBeenCalledOnce()
      await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  test('stops and cleans up when verification is cancelled during startup', async () => {
    const controller = new AbortController()
    let temporaryRoot = ''
    const stop = vi.fn().mockResolvedValue(undefined)
    const dependencies = fixtureDependencies({
      prepareLaunch: async options => {
        temporaryRoot = options.dataDirectory
        return launch(options.dataDirectory, options.port)
      },
      createRuntime: () => ({
        url: () => 'http://127.0.0.1:41001/',
        start: () => {
          controller.abort(new Error('cancelled'))
          return new Promise(() => {})
        },
        stop,
      }),
    })

    const result = await verifySmartAppRuntime(options({ signal: controller.signal }), dependencies)

    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'SA-RUNTIME-CANCELLED', stage: 'runtime' }),
    ])
    expect(stop).toHaveBeenCalledOnce()
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function options(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: '/project',
    runtimeRoot: '/runtime',
    logDirectory: '/logs',
    environment: { PATH: '/managed/bin' },
    manifest: {
      name: 'fixture',
      displayName: 'Fixture',
      version: '1.0.0',
      type: 'deepseek-harness-plugin-bundle' as const,
      description: 'Fixture',
      entry: { installPackage: 'package', profile: 'web' },
      requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
    },
    contract: contract(),
    ...overrides,
  }
}

function contract(): SmartAppVerificationContract {
  return {
    schemaVersion: 1,
    scripts: {
      typecheck: 'typecheck',
      test: 'test',
      build: 'build',
      runtimeProbe: 'runtime:probe',
    },
    capabilities: { host: true, client: true, remote: true },
    runtime: {
      profile: 'web',
      path: '/',
      readySelector: '[data-testid="smart-app-ready"]',
    },
  }
}

function launch(dataDirectory: string, port: number): WorkbenchDshLaunch {
  return {
    command: '/managed/node',
    entry: '/runtime/dsh.js',
    args: ['/runtime/dsh.js', '--profile', 'web', '--no-open', '--port', String(port)],
    cwd: '/runtime',
    dshHome: `${dataDirectory}/harness-apps/instances/fixture`,
    environment: { PATH: '/managed/bin', DSH_HOME: dataDirectory },
    profile: 'web',
    url: `http://127.0.0.1:${port}/`,
    version: '0.1.0-rc.8',
    sourceFingerprint: 'a'.repeat(64),
  }
}

function fixtureDependencies(
  overrides: Partial<SmartAppRuntimeVerifierDependencies> = {}
): SmartAppRuntimeVerifierDependencies {
  return {
    prepareLaunch: async options => launch(options.dataDirectory, options.port),
    createRuntime: () => ({
      start: vi.fn().mockResolvedValue(undefined),
      url: () => 'http://127.0.0.1:41001/',
      stop: vi.fn().mockResolvedValue(undefined),
    }),
    runCommand: vi.fn().mockResolvedValue(undefined),
    verifyPage: vi.fn().mockResolvedValue({ issues: [] }),
    runProbe: vi.fn().mockResolvedValue({ issues: [] }),
    copyProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function runtimeIssue(code: string) {
  return {
    code,
    stage: 'runtime' as const,
    file: null,
    message: code,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}
