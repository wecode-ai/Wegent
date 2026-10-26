import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  runSmartAppProjectScripts,
  runSmartAppRuntimeProbe,
  type SmartAppScriptCommandRunner,
} from './smart-app-project-script-runner.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('runSmartAppProjectScripts', () => {
  test.each(['pnpm@99.0.0', 'pnpm@11.7.0'])(
    'ignores the containing workspace when running prepared project scripts (%s)',
    async packageManager => {
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
          scripts: { check: 'node -e "process.exit(0)"' },
        })
      )
      const pnpmEntry = process.env.npm_execpath
      if (!pnpmEntry) throw new Error('Run this regression through pnpm test')
      // npm_execpath can name either a JavaScript entry or a standalone executable.
      const nodeEntry = /\.[cm]?js$/i.test(pnpmEntry)
      const result = await runSmartAppProjectScripts({
        ...options(root),
        scripts: { typecheck: 'check', test: 'check', build: 'check' },
        resolveCommand: async () => ({
          command: nodeEntry ? process.execPath : pnpmEntry,
          argsPrefix: [...(nodeEntry ? [pnpmEntry] : []), '--pm-on-fail=error'],
          environment: { PATH: process.env.PATH, CI: 'true' },
        }),
      })
      const logs = await Promise.all(
        result.scripts.map(script => readFile(join(root, script.logPath), 'utf8'))
      )
      expect(result.issues, JSON.stringify({ node: process.execPath, pnpmEntry, logs })).toEqual([])
      expect(result.scripts.map(script => script.status)).toEqual(['passed', 'passed', 'passed'])
      await expect(readFile(join(host, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

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
