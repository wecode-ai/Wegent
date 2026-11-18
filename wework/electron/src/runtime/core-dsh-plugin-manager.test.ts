import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { PassThrough } from 'node:stream'
import { create as createTar } from 'tar'
import { describe, expect, test, vi } from 'vitest'
import {
  CoreDshPluginManager,
  type CoreDshPluginInstallRequest,
  validateCoreDshDevelopmentPlugin,
} from './core-dsh-plugin-manager.js'
import { temporaryDirectory, testNodeEnvironment } from './test-helpers.js'
import { prepareElectronNodeRuntime } from './electron-node-runtime.js'

vi.mock('node:child_process', { spy: true })

describe('CoreDshPluginManager', () => {
  test.runIf(process.platform === 'win32')(
    'validates a profile and supervised process from Electron beyond MAX_PATH',
    async () => {
      const fixture = await createFixture()
      try {
        const require = createRequire(import.meta.url)
        const compiled = join(fixture.root, 'compiled')
        await promisify(execFile)(
          process.execPath,
          [
            require.resolve('typescript/bin/tsc'),
            '-p',
            fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
            '--outDir',
            compiled,
          ],
          { timeout: 30000 }
        )
        await writeJson(join(compiled, 'package.json'), { type: 'module' })
        let runtimeRoot = fixture.runtimeRoot
        while (runtimeRoot.length < 320)
          runtimeRoot = join(runtimeRoot, 'versioned-runtime-directory')
        await mkdir(runtimeRoot, { recursive: true })
        const observed = join(fixture.root, 'observed.json')
        const dshEntry = join(runtimeRoot, 'dsh.cjs')
        await writeFile(
          dshEntry,
          `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd() }))`
        )
        const pnpmEntry = process.env.npm_execpath
        expect(pnpmEntry).toBeTruthy()
        const patchedPnpm = join(fixture.root, 'pnpm')
        await cp(dirname(dirname(pnpmEntry!)), patchedPnpm, {
          recursive: true,
          dereference: true,
        })
        expect((await lstat(patchedPnpm)).isSymbolicLink()).toBe(false)
        await promisify(execFile)(
          'git',
          [
            'apply',
            fileURLToPath(
              new URL('../../../harness-runtime/patches/pnpm@11.7.0.patch', import.meta.url)
            ),
          ],
          { cwd: patchedPnpm }
        )
        // Writable profiles remain outside the versioned runtime in production.
        let packageHome = join(fixture.root, 'plugin-home')
        while (packageHome.length < 175) packageHome = join(packageHome, 'nested-profile-directory')
        const packageProfile = join(packageHome, 'profiles', 'wework-core')
        const dependencyRoot = join(fixture.root, 'dependency', 'package')
        await mkdir(dependencyRoot, { recursive: true })
        await writeJson(join(dependencyRoot, 'package.json'), {
          name: 'deep-import-dependency',
          version: '1.0.0',
          main: 'index.js',
          scripts: { postinstall: 'node postinstall.cjs' },
        })
        await writeFile(join(dependencyRoot, 'index.js'), 'module.exports = 42\n')
        await writeFile(
          join(dependencyRoot, 'postinstall.cjs'),
          "require('node:fs').writeFileSync('built.txt', 'ready')\n"
        )
        const dependencyArchive = join(fixture.root, 'dependency.tgz')
        const dependencySpec = `file:${relative(packageProfile, dependencyArchive).split(sep).join('/')}`
        await createTar(
          { cwd: join(fixture.root, 'dependency'), file: dependencyArchive, gzip: true },
          ['package']
        )
        await mkdir(packageProfile, { recursive: true })
        await writeJson(join(packageProfile, 'package.json'), {
          name: 'deep-runtime-profile',
          private: true,
          dependencies: { 'deep-import-dependency': dependencySpec },
          dsh: { profile: { bundles: [] } },
        })
        await writeFile(
          join(packageProfile, 'pnpm-workspace.yaml'),
          `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  ${JSON.stringify(`deep-import-dependency@${dependencySpec}`)}: true\n`
        )
        const pluginRoot = join(fixture.root, 'local-bundle')
        await mkdir(pluginRoot)
        await writeJson(join(pluginRoot, 'package.json'), {
          name: 'deep-runtime-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        })
        await writeFile(join(pluginRoot, 'cordis.patch.yml'), '[]\n')
        const packageEntry = join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        await mkdir(join(runtimeRoot, 'node_modules', 'pnpm', 'bin'), { recursive: true })
        await writeFile(
          packageEntry,
          `import(${JSON.stringify(pathToFileURL(join(patchedPnpm, 'bin', 'pnpm.cjs')).href)})`
        )
        const electron = require('electron') as string
        const runtime = await prepareElectronNodeRuntime({
          dataDirectory: fixture.root,
          environment: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
          },
          helperExecPath: electron,
          nodeVersion: 'test',
          platform: process.platform,
        })
        const harness = join(fixture.root, 'parent.mjs')
        await writeFile(
          harness,
          `
import { CoreDshPluginManager } from ${JSON.stringify(pathToFileURL(join(compiled, 'runtime/core-dsh-plugin-manager.js')).href)}
import { RuntimeSupervisor } from ${JSON.stringify(pathToFileURL(join(compiled, 'runtime/runtime-supervisor.js')).href)}
import { stopProcess } from ${JSON.stringify(new URL('../../../e2e/desktop/process-lifecycle.mjs', import.meta.url).href)}
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { readFile, rename } from 'node:fs/promises'
const manager = new CoreDshPluginManager(${JSON.stringify({
            dshHome: join(fixture.root, 'home'),
            runtimeRoot,
            dshEntry,
            nodeCommand: runtime.environment.WEWORK_NODE_PATH,
            environment: runtime.environment,
          })})
await manager.setEnabled('dsh-alpha', false)
await rename(${JSON.stringify(observed)}, ${JSON.stringify(join(fixture.root, 'manager-observed.json'))})
const supervisor = new RuntimeSupervisor(${JSON.stringify({
            command: runtime.environment.WEWORK_NODE_PATH,
            args: [dshEntry],
            cwd: runtimeRoot,
            env: runtime.environment,
            name: 'deep-runtime',
          })})
try {
  const child = await supervisor.start()
  await once(child, 'close')
} finally {
  await supervisor.stop()
}
await rename(${JSON.stringify(observed)}, ${JSON.stringify(join(fixture.root, 'supervisor-observed.json'))})
const packageManager = new CoreDshPluginManager({ ...${JSON.stringify({
            dshHome: packageHome,
            runtimeRoot,
            dshEntry,
            nodeCommand: runtime.environment.WEWORK_NODE_PATH,
            environment: runtime.environment,
          })}, confirmInstall: async () => true })
const installed = await packageManager.install(${JSON.stringify(pluginRoot)})
if (!installed.some(plugin => plugin.name === 'deep-runtime-plugin')) throw new Error('Local plugin was not installed')
const dependency = await readFile(${JSON.stringify(join(packageProfile, 'node_modules', 'deep-import-dependency', 'index.js'))}, 'utf8')
if (dependency !== ${JSON.stringify('module.exports = 42\n')}) throw new Error('Archive dependency was not imported')
const built = await readFile(${JSON.stringify(join(packageProfile, 'node_modules', 'deep-import-dependency', 'built.txt'))}, 'utf8')
if (built !== 'ready') throw new Error('Archive dependency build did not complete')
const removed = await packageManager.uninstall('deep-runtime-plugin')
if (removed.some(plugin => plugin.name === 'deep-runtime-plugin')) throw new Error('Local plugin remained installed')
const nativeChild = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume()'], { env: process.env })
const childClosed = once(nativeChild, 'close')
await once(nativeChild.stdout, 'data')
const originalKill = process.kill
process.kill = function(pid, signal) {
  if (pid === nativeChild.pid && signal === 0) throw Object.assign(new Error('PID is no longer visible'), { code: 'ESRCH' })
  return originalKill.call(process, pid, signal)
}
try {
  await stopProcess(nativeChild)
  if (nativeChild.exitCode === null && nativeChild.signalCode === null) throw new Error('Shutdown returned before the native exit event')
} finally {
  process.kill = originalKill
  if (nativeChild.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGKILL')
  await childClosed
}
`
        )
        await promisify(execFile)(electron, [harness], {
          env: { ...runtime.environment, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 10000,
        })
        const result = JSON.parse(
          await readFile(join(fixture.root, 'supervisor-observed.json'), 'utf8')
        ) as { cwd: string }
        expect(await realpath(result.cwd)).toBe(await realpath(runtimeRoot))
        const managerResult = JSON.parse(
          await readFile(join(fixture.root, 'manager-observed.json'), 'utf8')
        ) as { cwd: string }
        expect(await realpath(managerResult.cwd)).toBe(await realpath(runtimeRoot))
      } finally {
        await fixture.remove()
      }
    },
    45000
  )

  test.each(['stdout', 'stderr'] as const)(
    'retains the spawn error when its disconnected %s pipe also fails',
    async stream => {
      const fixture = await createFixture({ realCommands: true })
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        pid: undefined,
      })
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => {
          child[stream].emit(
            'error',
            Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' })
          )
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
        })
        return child as unknown as ReturnType<typeof spawn>
      })
      try {
        await expect(fixture.manager().setEnabled('dsh-alpha', false)).rejects.toThrow(
          'spawn ENOENT'
        )
      } finally {
        await fixture.remove()
      }
    }
  )

  test('rejects a pipe failure even when the process exited successfully before stdio closed', async () => {
    const fixture = await createFixture({ realCommands: true })
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 123,
      exitCode: 0,
      signalCode: null,
    })
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.emit('exit', 0)
        child.stderr.emit('error', new Error('read EIO'))
        child.emit('close', 0)
      })
      return child as unknown as ReturnType<typeof spawn>
    })
    try {
      await expect(fixture.manager().setEnabled('dsh-alpha', false)).rejects.toThrow('read EIO')
    } finally {
      await fixture.remove()
    }
  })

  test.each([undefined, { '.': './index.js' }])(
    'preserves installation-owned bundles with exports %j while toggling a workspace plugin',
    async exports => {
      const fixture = await createFixture()
      const bundle = '@deepseek-ai/dsh-experimental-voice-input-bundle'
      const pnpmModules = join(fixture.runtimeRoot, 'node_modules', '.pnpm', 'dsh', 'node_modules')
      const entry = join(pnpmModules, '@deepseek-ai', 'dsh', 'cli.js')
      await mkdir(join(pnpmModules, '@deepseek-ai', 'dsh'), { recursive: true })
      await writeFile(entry, '')
      await rm(join(fixture.runtimeRoot, 'dsh.js'))
      await symlink(entry, join(fixture.runtimeRoot, 'dsh.js'))
      const packageRoot = join(pnpmModules, ...bundle.split('/'))
      await mkdir(packageRoot, { recursive: true })
      await writeJson(join(packageRoot, 'package.json'), {
        name: bundle,
        exports,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })
      const manifest = await fixture.manifest()
      manifest.dsh.profile.bundles.push(bundle)
      await fixture.writeManifest(manifest)

      await fixture.manager().setEnabled('dsh-alpha', false)

      expect((await fixture.manifest()).dsh.profile.bundles).toEqual([
        '@wegent/dsh-app-wework',
        bundle,
        'dsh-beta',
      ])
      await fixture.remove()
    }
  )

  test('removes uninstalled user bundles instead of retaining them as installation bundles', async () => {
    const fixture = await createFixture({
      runCommand: async (_command, args) => {
        if (args.includes('remove')) {
          const manifest = await fixture.manifest()
          delete manifest.dependencies['dsh-alpha']
          await fixture.writeManifest(manifest)
        }
        return { stdout: '', stderr: '' }
      },
    })

    await fixture.manager().uninstall('dsh-alpha')

    expect(await fixture.userBundles()).toEqual(['dsh-beta'])
    await fixture.remove()
  })

  test('preserves disabled plugins and bundle order across unrelated updates', async () => {
    const fixture = await createFixture()
    const manager = fixture.manager()

    await manager.setEnabled('dsh-alpha', false)
    await manager.update('dsh-beta')
    expect(await fixture.userBundles()).toEqual(['dsh-beta'])

    await manager.setEnabled('dsh-alpha', true)
    expect(await fixture.userBundles()).toEqual(['dsh-alpha', 'dsh-beta'])

    const plugins = await manager.list()
    expect(plugins.find(plugin => plugin.name === 'dsh-alpha')).toMatchObject({
      enabled: true,
      immutable: false,
      canToggle: true,
    })
    expect(plugins.some(plugin => plugin.name === 'plain-runtime-library')).toBe(false)
    await fixture.remove()
  })

  test('rejects non-bundle packages and restores the profile manifest', async () => {
    const fixture = await createFixture({
      runCommand: async (_command, args) => {
        if (!args.includes('add')) return { stdout: '', stderr: '' }
        const manifest = await fixture.manifest()
        manifest.dependencies['plain-library'] = '1.0.0'
        await fixture.writeManifest(manifest)
        await fixture.writePackage('plain-library', {
          name: 'plain-library',
          version: '1.0.0',
        })
        return { stdout: '', stderr: '' }
      },
    })
    const before = await fixture.manifest()

    await expect(fixture.manager().install('plain-library')).rejects.toThrow(
      'does not declare dsh.bundle.patch'
    )
    expect(await fixture.manifest()).toEqual(before)
    await fixture.remove()
  })

  test('protects built-in plugins from mutation', async () => {
    const fixture = await createFixture()
    await expect(fixture.manager().setEnabled('@wegent/dsh-app-wework', false)).rejects.toThrow(
      'built-in Core DSH plugin'
    )
    await expect(fixture.manager().setEnabled('@wework/dsh-browser-auth', false)).rejects.toThrow(
      'built-in Core DSH plugin'
    )
    await fixture.remove()
  })

  test('rejects relative local paths before invoking pnpm', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fixture = await createFixture({ runCommand })
    await expect(fixture.manager().install('../plugin')).rejects.toThrow('absolute local directory')
    expect(runCommand).not.toHaveBeenCalled()
    await fixture.remove()
  })

  test.each(['cancel', 'unavailable', 'error'] as const)(
    'never runs pnpm or recovery when native approval is %s',
    async decision => {
      const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
      const confirmInstall =
        decision === 'unavailable'
          ? null
          : vi.fn(async () => {
              if (decision === 'error') throw new Error('Native window unavailable')
              return false
            })
      const fixture = await createFixture({ runCommand, confirmInstall })
      try {
        const before = await fixture.manifest()
        const manager = fixture.manager()
        await expect(
          manager.install('arbitrary-plugin@https://example.test/plugin.tgz')
        ).rejects.toThrow(decision === 'error' ? 'Native window unavailable' : 'cancelled')
        await expect(manager.update('dsh-alpha')).rejects.toThrow()
        expect(await fixture.manifest()).toEqual(before)
        expect(runCommand).not.toHaveBeenCalled()
      } finally {
        await fixture.remove()
      }
    }
  )

  test('waits for a fresh native decision before every update and keeps the queue usable', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    let decide!: (allowed: boolean) => void
    const confirmInstall = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          decide = resolve
        })
    )
    const fixture = await createFixture({ runCommand, confirmInstall })
    try {
      const manager = fixture.manager()
      const first = manager.update('dsh-alpha')
      await vi.waitFor(() => expect(confirmInstall).toHaveBeenCalledTimes(1))
      expect(confirmInstall).toHaveBeenLastCalledWith({ action: 'update', spec: 'dsh-alpha@1.0.0' })
      expect(runCommand).not.toHaveBeenCalled()
      decide(true)
      await first
      runCommand.mockClear()
      const second = manager.update('dsh-alpha')
      await vi.waitFor(() => expect(confirmInstall).toHaveBeenCalledTimes(2))
      expect(runCommand).not.toHaveBeenCalled()
      const rejected = expect(second).rejects.toThrow('cancelled')
      decide(false)
      await rejected
      expect(runCommand).not.toHaveBeenCalled()
      expect(await manager.list()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'dsh-alpha' })])
      )
    } finally {
      await fixture.remove()
    }
  })

  test('runs pnpm from the profile and validates DSH from the runtime root', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fixture = await createFixture({ runCommand })

    await fixture.manager().update('dsh-alpha')

    const pnpmCalls = runCommand.mock.calls.filter(([, args]) => args.includes('update'))
    expect(pnpmCalls).toHaveLength(1)
    expect(pnpmCalls[0]?.[2]?.cwd).toBe(fixture.profileRoot)
    expect(pnpmCalls[0]?.[1]).toEqual(expect.arrayContaining(['--dir', fixture.profileRoot]))
    expect(pnpmCalls[0]?.[1]).toEqual(
      expect.arrayContaining(['--store-dir', join(fixture.profileRoot, '..', '..', 'pnpm-store')])
    )
    const preflightCall = runCommand.mock.calls.find(([, args]) => args.includes('--dump-config'))
    expect(preflightCall?.[2]?.cwd).toBe(fixture.runtimeRoot)
    await fixture.remove()
  })

  test('uses Electron runtime Node arguments for plugin commands', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const fixture = await createFixture({
      environment: { WEWORK_NODE_RUNTIME_KIND: 'electron' },
      runCommand,
    })

    await fixture.manager().update('dsh-alpha')

    const pnpmCall = runCommand.mock.calls.find(([, args]) => args.includes('update'))
    expect(pnpmCall?.[1].slice(0, 2)).toEqual([
      '--expose-internals',
      join(fixture.runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ])
    const preflightCall = runCommand.mock.calls.find(([, args]) => args.includes('--dump-config'))
    expect(preflightCall?.[1].slice(0, 2)).toEqual([
      '--expose-internals',
      join(fixture.runtimeRoot, 'dsh.js'),
    ])
    await fixture.remove()
  })

  test('links a development plugin and enables HMR only for its source root', async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('add')) {
        const manifest = await fixture.manifest()
        manifest.dependencies['dsh-development'] = 'link:development-plugin'
        await fixture.writeManifest(manifest)
        await fixture.writePackage('dsh-development', {
          name: 'dsh-development',
          displayName: 'Development plugin',
          version: '0.1.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        })
      }
      return { stdout: '', stderr: '' }
    })
    const fixture = await createFixture({ runCommand })
    const source = join(fixture.root, 'development-plugin')
    await mkdir(source, { recursive: true })
    await writeJson(join(source, 'package.json'), {
      name: 'dsh-development',
      displayName: 'Development plugin',
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    await writeFile(join(source, 'cordis.patch.yml'), '[]\n')

    const plugin = await fixture.manager().ensureDevelopmentPlugin(source)

    expect(plugin).toMatchObject({
      name: 'dsh-development',
      displayName: 'Development plugin',
      sourceRoot: source,
    })
    expect(runCommand.mock.calls.some(([, args]) => args.includes(`link:${source}`))).toBe(true)
    expect(await readFile(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toContain(
      JSON.stringify(source)
    )
    expect(await readFile(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toContain(
      '- id: client-hmr\n  disabled: false'
    )
    expect(await readFile(join(fixture.profileRoot, 'cordis.patch.yml'), 'utf8')).toContain(
      '- id: hmr\n  disabled: false'
    )
    expect(await fixture.userBundles()).toEqual(['dsh-alpha', 'dsh-beta', 'dsh-development'])
    await fixture.remove()
  })

  test('validates an absolute Core DSH development plugin directory', async () => {
    const root = await temporaryDirectory('core-dsh-development-validation-')
    await writeJson(join(root.path, 'package.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    await writeFile(join(root.path, 'cordis.patch.yml'), '[]\n')

    await expect(validateCoreDshDevelopmentPlugin(root.path)).resolves.toMatchObject({
      name: 'dsh-development',
      sourceRoot: root.path,
    })
    await expect(validateCoreDshDevelopmentPlugin('./relative-plugin')).rejects.toThrow(
      'absolute source directory'
    )
    await writeJson(join(root.path, 'package.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      dsh: { bundle: { patch: '../outside.yml' } },
    })
    await writeFile(join(root.path, '..', 'outside.yml'), '[]\n')
    await expect(validateCoreDshDevelopmentPlugin(root.path)).rejects.toThrow(
      'outside the plugin directory'
    )
    await writeJson(join(root.path, 'package.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      dsh: { bundle: { patch: '.' } },
    })
    await expect(validateCoreDshDevelopmentPlugin(root.path)).rejects.toThrow('not a file')
    await root.remove()
  })

  test('validates a declared Codex plugin as a nested official plugin directory', async () => {
    const root = await temporaryDirectory('core-dsh-development-codex-plugin-')
    await writeJson(join(root.path, 'package.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      wework: { codexPlugin: './codex-plugin' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    await writeFile(join(root.path, 'cordis.patch.yml'), '[]\n')
    await mkdir(join(root.path, 'codex-plugin', '.codex-plugin'), { recursive: true })
    await writeJson(join(root.path, 'codex-plugin/.codex-plugin/plugin.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      skills: './skills/',
    })

    await expect(validateCoreDshDevelopmentPlugin(root.path)).resolves.toMatchObject({
      name: 'dsh-development',
      sourceRoot: root.path,
    })

    await writeJson(join(root.path, 'package.json'), {
      name: 'dsh-development',
      version: '0.1.0',
      wework: { codexPlugin: '../codex-plugin' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    await expect(validateCoreDshDevelopmentPlugin(root.path)).rejects.toThrow(
      'wework.codexPlugin outside the plugin directory'
    )
    await root.remove()
  })

  test('never turns a package-manager build rejection into permission to execute package code', async () => {
    const runCommand = vi.fn(async () => {
      throw Object.assign(new Error('Build rejected'), {
        stderr:
          'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\nallowBuilds:\n  "codeload.github.com/o/p/tar.gz/a": true\n',
      })
    })
    const fixture = await createFixture({ runCommand })
    try {
      const path = join(fixture.profileRoot, 'pnpm-workspace.yaml')
      const before = await readFile(path, 'utf8')
      await expect(fixture.manager().install('git+https://github.com/o/p.git')).rejects.toThrow(
        'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED'
      )
      expect(runCommand).toHaveBeenCalledTimes(1)
      expect(await readFile(path, 'utf8')).toBe(before)
    } finally {
      await fixture.remove()
    }
  })
})

async function createFixture(
  options: {
    environment?: NodeJS.ProcessEnv
    realCommands?: boolean
    confirmInstall?: ((request: CoreDshPluginInstallRequest) => Promise<boolean>) | null
    runCommand?: (
      command: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv }
    ) => Promise<{ stdout: string; stderr: string }>
  } = {}
) {
  const root = await temporaryDirectory('core-dsh-plugins-')
  const dshHome = join(root.path, 'home')
  const runtimeRoot = join(root.path, 'runtime')
  const profileRoot = join(dshHome, 'profiles', 'wework-core')
  await mkdir(profileRoot, { recursive: true })
  await mkdir(join(runtimeRoot, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  await writeFile(join(runtimeRoot, 'dsh.js'), '')
  await writeFile(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
  const manifest = {
    dependencies: {
      '@wegent/dsh-app-wework': 'file:/runtime/app',
      'dsh-alpha': '1.0.0',
      'dsh-beta': '1.0.0',
      'plain-runtime-library': '1.0.0',
    } as Record<string, string>,
    dsh: {
      profile: {
        bundles: ['@wegent/dsh-app-wework', 'dsh-alpha', 'dsh-beta'],
      },
    },
  }
  await writeJson(join(profileRoot, 'package.json'), manifest)
  await writeFile(join(profileRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n')

  const writePackage = async (name: string, value: Record<string, unknown>) => {
    const packageRoot = join(profileRoot, 'node_modules', ...name.split('/'))
    await mkdir(packageRoot, { recursive: true })
    await writeJson(join(packageRoot, 'package.json'), value)
    if (
      value.dsh &&
      typeof value.dsh === 'object' &&
      (value.dsh as { bundle?: { patch?: string } }).bundle?.patch
    ) {
      await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
    }
  }
  await writePackage('@wegent/dsh-app-wework', {
    name: '@wegent/dsh-app-wework',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('dsh-alpha', {
    name: 'dsh-alpha',
    displayName: 'Alpha',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('dsh-beta', {
    name: 'dsh-beta',
    displayName: 'Beta',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writePackage('plain-runtime-library', {
    name: 'plain-runtime-library',
    version: '1.0.0',
  })

  const fixture = {
    manager: () =>
      new CoreDshPluginManager({
        dshHome,
        runtimeRoot,
        dshEntry: join(runtimeRoot, 'dsh.js'),
        nodeCommand: process.execPath,
        environment: testNodeEnvironment(options.environment),
        confirmInstall:
          options.confirmInstall === null
            ? undefined
            : (options.confirmInstall ?? (async () => true)),
        runCommand: options.realCommands
          ? undefined
          : (options.runCommand ??
            (async () => ({
              stdout: '',
              stderr: '',
            }))),
      }),
    manifest: () =>
      readFile(join(profileRoot, 'package.json'), 'utf8').then(
        value => JSON.parse(value) as typeof manifest
      ),
    writeManifest: (value: typeof manifest) => writeJson(join(profileRoot, 'package.json'), value),
    writePackage,
    root: root.path,
    profileRoot,
    runtimeRoot,
    userBundles: async () =>
      (await fixture.manifest()).dsh.profile.bundles.filter(
        name => name !== '@wegent/dsh-app-wework'
      ),
    remove: root.remove,
  }
  return fixture
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('redacts bearer and registry credentials from package-manager failures', async () => {
  const fixture = await createFixture({
    runCommand: async () => {
      throw Object.assign(new Error('Package manager rejected the install'), {
        stdout:
          'Authorization: Bearer synthetic-auth-value\nhttps://user:synthetic-pass@registry.example.test/package',
        stderr: '',
      })
    },
  })
  try {
    const error = await fixture
      .manager()
      .install('dsh-example')
      .catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain('synthetic-auth-value')
    expect(error.message).not.toContain('synthetic-pass')
  } finally {
    await fixture.remove()
  }
})

test('logs only allowlisted metadata from secret-bearing subprocess chunks', async () => {
  const fixture = await createFixture({
    environment: { VITE_WEWORK_E2E: 'true' },
    realCommands: true,
  })
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    await writeFile(
      join(fixture.runtimeRoot, 'node_modules/pnpm/bin/pnpm.cjs'),
      `
      const chunks = [
        ['stdout', 'https://user:synthetic-split-'],
        ['stdout', 'password@registry.example.test/package\\n'],
        ['stdout', '{"token":"synthetic-json-secret"}\\n'],
        ['stderr', 'Authorization: Bearer synthetic-bearer-secret\\n'],
        ['stdout', 'Progress: resolved 3, reused 1, downloaded 2, added 2\\nECONNRESET\\n'],
      ]
      async function main() {
        for (const [stream, text] of chunks) {
          process[stream].write(text)
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        process.exitCode = 1
      }
      main()
    `
    )
    await expect(fixture.manager().install('dsh-example')).rejects.toThrow('pnpm failed')
    const recorded = JSON.stringify(logs.mock.calls)
    expect(recorded).not.toContain('synthetic-')
    expect(recorded).not.toContain('registry.example.test')
    expect(recorded).not.toContain('"output"')
    expect(recorded).toContain('ECONNRESET')
    expect(logs).toHaveBeenCalledWith(
      '[core-dsh-plugin-command]',
      expect.objectContaining({
        stage: 'command-output',
        resolved: 3,
        reused: 1,
        downloaded: 2,
        added: 2,
      })
    )
  } finally {
    logs.mockRestore()
    await fixture.remove()
  }
})
