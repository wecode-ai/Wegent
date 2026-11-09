import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { testNodeRuntime } from '../runtime/test-helpers.js'
import {
  runSmartAppProjectScripts,
  runSmartAppRuntimeProbe,
  type SmartAppScriptCommandRunner,
} from './smart-app-project-script-runner.js'

vi.mock('node:child_process', { spy: true })

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('runSmartAppProjectScripts', () => {
  test.for([
    { packageManager: 'pnpm@99.0.0', runtime: 'current' },
    { packageManager: 'pnpm@11.7.0', runtime: 'current' },
    { packageManager: 'pnpm@99.0.0', runtime: 'electron' },
    { packageManager: 'pnpm@11.7.0', runtime: 'electron' },
  ])(
    'ignores the containing workspace for $packageManager with the $runtime runtime',
    async ({ packageManager, runtime }, { signal }) => {
      const host = await projectRoot()
      const root = join(host, 'fixtures', 'smart-app')
      await mkdir(root, { recursive: true })
      await writeFile(
        join(host, 'package.json'),
        JSON.stringify({ name: 'host-workspace', packageManager })
      )
      await writeFile(join(host, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'prepared-project',
          scripts: { check: 'node check.cjs' },
        })
      )
      await writeFile(
        join(root, 'check.cjs'),
        "require('node:fs').appendFileSync('checks.log', 'checked\\n')\n"
      )
      // Exercise the managed runtime's JavaScript CLI rather than the host pnpm distribution.
      const pnpmEntry = join(
        dirname(createRequire(import.meta.url).resolve('pnpm')),
        'bin',
        'pnpm.cjs'
      )
      const node = await testNodeRuntime(
        host,
        runtime === 'electron'
          ? { command: createRequire(import.meta.url)('electron'), kind: 'electron' }
          : undefined
      )
      const running = runSmartAppProjectScripts({
        ...options(root),
        signal,
        scripts: { typecheck: 'check', test: 'check', build: 'check' },
        resolveCommand: async () => ({
          command: node.command,
          argsPrefix: [...node.argsPrefix, pnpmEntry, '--pm-on-fail=error'],
          environment: { ...node.environment, CI: 'true' },
        }),
      })
      cleanups.push(async () => {
        try {
          await running
        } catch (error) {
          if (!signal.aborted) throw error
        }
      })
      const result = await running
      const logs = await Promise.all(
        result.scripts.map(script => readFile(join(root, script.logPath), 'utf8'))
      )
      expect(result.issues, JSON.stringify({ node: process.execPath, pnpmEntry, logs })).toEqual([])
      expect(result.scripts.map(script => script.status)).toEqual(['passed', 'passed', 'passed'])
      expect(await readFile(join(root, 'checks.log'), 'utf8')).toBe('checked\n'.repeat(3))
      await expect(readFile(join(host, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
    // This integration case starts three real pnpm/Node process pairs sequentially.
    15_000
  )

  test.each(['scripts', 'probe'] as const)(
    'cancels %s and stops the real process tree',
    async kind => {
      const root = await projectRoot()
      const node = await testNodeRuntime(root)
      const pidPath = join(root, 'child.pid')
      const fixture = join(root, 'hold.cjs')
      await writeFile(
        fixture,
        `const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e',
  'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.ppid, process.pid])); setInterval(() => {}, 1000)',
  ${JSON.stringify(pidPath)}], { stdio: 'inherit' })
// Reap the child before exiting, including under a container PID 1.
process.on('SIGTERM', () => {})
child.once('exit', () => process.exit(0))
setInterval(() => {}, 1000)
`
      )
      const controller = new AbortController()
      const resolveCommand = async () => ({ ...node, argsPrefix: [...node.argsPrefix, fixture] })
      const input = { ...options(root), resolveCommand, signal: controller.signal }
      const running =
        kind === 'scripts'
          ? runSmartAppProjectScripts(input)
          : runSmartAppRuntimeProbe({ ...input, script: 'probe', baseUrl: 'http://127.0.0.1/' })
      // Attach rejection handling before cancellation and always await cleanup, including failures.
      const rejected = expect(running).rejects.toThrow('cancel fixture')
      cleanups.push(async () => {
        controller.abort(new Error('cancel fixture'))
        await rejected
      })
      let pids: number[] = []
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await readFile(pidPath, 'utf8'))
          expect(pids).toHaveLength(2)
          for (const pid of pids) expect(pid).toBeGreaterThan(0)
        },
        { timeout: 4_000 }
      )

      controller.abort(new Error('cancel fixture'))
      await rejected

      await vi.waitFor(() => {
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        }
      })
    },
    10_000
  )

  test.each(['closed', 'inherited'] as const)(
    'finishes an exited script with %s output pipes and retains its logs',
    async pipes => {
      const root = await projectRoot()
      vi.useFakeTimers()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, stderr })
      const spawn = vi
        .spyOn(childProcess, 'spawn')
        .mockClear()
        .mockReturnValueOnce(child as ReturnType<typeof childProcess.spawn>)
      let settled = false
      const running = runSmartAppRuntimeProbe({
        ...options(root),
        script: 'probe',
        baseUrl: 'http://127.0.0.1/',
      }).then(result => {
        settled = true
        return result
      })
      cleanups.push(async () => {
        child.emit('close', 0)
        stdout.destroy()
        stderr.destroy()
        await running
      })
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      stdout.write('script output\n')
      child.emit('exit', 0)
      stderr.write('output draining after exit\n')

      if (pipes === 'closed') {
        child.emit('close', 0)
      } else {
        await vi.advanceTimersByTimeAsync(999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(stdout.destroyed).toBe(true)
        expect(stderr.destroyed).toBe(true)
      }

      await expect(running).resolves.toEqual({ issues: [] })
      expect(vi.getTimerCount()).toBe(0)
      const log = await readFile(
        join(root, 'test-results', 'smart-app', 'logs', 'runtime-probe.log'),
        'utf8'
      )
      expect(log).toContain('script output\n')
      expect(log).toContain('output draining after exit\n')
    }
  )

  test('does not resolve or start commands after cancellation', async () => {
    const root = await projectRoot()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before start'))
    const resolveCommand = vi.fn()
    const input = { ...options(root), resolveCommand, signal: controller.signal }

    await expect(runSmartAppProjectScripts(input)).rejects.toThrow('cancelled before start')
    await expect(
      runSmartAppRuntimeProbe({ ...input, script: 'probe', baseUrl: 'http://127.0.0.1/' })
    ).rejects.toThrow('cancelled before start')
    expect(resolveCommand).not.toHaveBeenCalled()
  })

  test('runs typecheck, test, and build in a fixed order through managed pnpm', async () => {
    const root = await projectRoot()
    const run = vi.fn<SmartAppScriptCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'passed',
      stderr: '',
    })

    const result = await runSmartAppProjectScripts({
      ...options(root),
      scripts: { typecheck: 'check:types', test: 'test:unit', build: 'build:release' },
      run,
    })

    expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'check:types',
      'test:unit',
      'build:release',
    ])
    expect(run).toHaveBeenCalledWith(
      '/managed/node',
      ['/managed/pnpm.cjs', '--config.verify-deps-before-run=false', 'run', 'check:types'],
      expect.objectContaining({ cwd: root, shell: false })
    )
    expect(result.issues).toEqual([])
    expect(result.scripts.map(script => script.status)).toEqual(['passed', 'passed', 'passed'])
  })

  test('stops immediately after a non-zero exit and returns a structured issue', async () => {
    const root = await projectRoot()
    const run = vi
      .fn<SmartAppScriptCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'failed' })

    const result = await runSmartAppProjectScripts({
      ...options(root),
      scripts: { typecheck: 'typecheck', test: 'test', build: 'build' },
      run,
    })

    expect(run).toHaveBeenCalledTimes(2)
    expect(result.scripts.map(script => script.status)).toEqual(['passed', 'failed'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'SA-SCRIPTS-TEST',
        stage: 'scripts',
        expected: 'exit code 0',
        actual: 'exit code 2',
        blocking: true,
      }),
    ])
    await expect(
      readFile(join(root, 'test-results/smart-app/logs/test.log'), 'utf8')
    ).resolves.toContain('failed')
  })

  test.each(['build && curl https://example.test', 'build\ncurl', '../build'])(
    'rejects unsafe script name %j without spawning a shell',
    async build => {
      const root = await projectRoot()
      const run = vi.fn<SmartAppScriptCommandRunner>()

      const result = await runSmartAppProjectScripts({
        ...options(root),
        scripts: { typecheck: 'typecheck', test: 'test', build },
        run,
      })

      expect(run).not.toHaveBeenCalled()
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'SA-SCRIPTS-NAME', stage: 'scripts' }),
      ])
    }
  )

  test('passes a sanitized environment to project scripts', async () => {
    const root = await projectRoot()
    const run = vi.fn<SmartAppScriptCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })

    await runSmartAppProjectScripts({
      ...options(root),
      environment: {
        PATH: '/managed/bin',
        LANG: 'zh_CN.UTF-8',
        DSH_HOME: '/personal/dsh',
        NPM_CONFIG_WORKSPACE_DIR: '/unrelated-workspace',
        WEWORK_HARNESS_CONTEXT_TOKEN: 'secret',
      },
      run,
    })

    const environment = run.mock.calls[0]?.[2].env
    expect(environment).toMatchObject({
      PATH: '/managed/bin',
      LANG: 'zh_CN.UTF-8',
      NPM_CONFIG_WORKSPACE_DIR: root,
    })
    expect(environment).not.toHaveProperty('DSH_HOME')
    expect(environment).not.toHaveProperty('WEWORK_HARNESS_CONTEXT_TOKEN')
  })

  test.each([undefined, 'dsh-auth-verification=isolated-cookie'])(
    'gives a runtime probe only its URL and isolated cookie (%s) beyond managed process state',
    async cookieHeader => {
      const root = await projectRoot()
      const run = vi.fn<SmartAppScriptCommandRunner>().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })

      const result = await runSmartAppRuntimeProbe({
        ...options(root),
        script: 'runtime:probe',
        baseUrl: 'http://127.0.0.1:41001/',
        cookieHeader,
        environment: {
          PATH: '/managed/bin',
          DSH_HOME: '/personal/dsh',
          WEWORK_HARNESS_CONTEXT_TOKEN: 'secret',
        },
        run,
      })

      expect(result).toEqual({ issues: [] })
      expect(run.mock.calls[0]?.[2].env).toEqual({
        PATH: '/managed/bin',
        NPM_CONFIG_WORKSPACE_DIR: root,
        SMART_APP_BASE_URL: 'http://127.0.0.1:41001/',
        ...(cookieHeader ? { SMART_APP_COOKIE: cookieHeader } : {}),
      })
    }
  )
})

function options(projectRoot: string) {
  return {
    projectRoot,
    runtimeRoot: '/runtime',
    environment: { PATH: '/managed/bin' },
    scripts: { typecheck: 'typecheck', test: 'test', build: 'build' },
    resolveCommand: async ({ environment }: { environment: NodeJS.ProcessEnv }) => ({
      command: '/managed/node',
      argsPrefix: ['/managed/pnpm.cjs'],
      environment,
    }),
  }
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-scripts-'))
  roots.push(root)
  await mkdir(join(root, 'test-results'), { recursive: true })
  return root
}
