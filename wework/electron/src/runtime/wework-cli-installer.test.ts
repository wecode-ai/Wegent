import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  installWeworkCli,
  shouldInstallUserWeworkCli,
  withWeworkCliEnvironment,
} from './wework-cli-installer.js'
import { resolveSpawnCommand } from './spawn-command.js'

const directories: string[] = []
const execFileAsync = promisify(execFile)

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
}

function posixCommandFixture(logPath: string, includeElectronRunAsNode: boolean): string {
  return [
    '#!/bin/sh',
    '{',
    ...(includeElectronRunAsNode
      ? [
          '  if [ -n "${ELECTRON_RUN_AS_NODE+x}" ]; then',
          '    printf "%s\\n" "$ELECTRON_RUN_AS_NODE"',
          '  else',
          '    printf "unset\\n"',
          '  fi',
        ]
      : []),
    '  for argument in "$@"; do',
    '    printf "%s\\n" "$argument"',
    '  done',
    `} > ${posixQuote(logPath)}`,
    '',
  ].join('\n')
}

function windowsCommandFixture(logPath: string, includeElectronRunAsNode: boolean): string {
  return [
    '@echo off',
    `> ${windowsQuote(logPath)} (`,
    ...(includeElectronRunAsNode
      ? ['  if "%ELECTRON_RUN_AS_NODE%"=="" (echo unset) else (echo %ELECTRON_RUN_AS_NODE%)']
      : []),
    '  for %%A in (%*) do echo(%%~A',
    ')',
    '',
  ].join('\r\n')
}

async function createCommandFixture(
  root: string,
  name: string,
  logPath: string,
  includeElectronRunAsNode: boolean
): Promise<string> {
  if (process.platform === 'win32') {
    const path = join(root, `${name}.cmd`)
    await writeFile(path, windowsCommandFixture(logPath, includeElectronRunAsNode))
    return path
  }
  const path = join(root, name)
  await writeFile(path, posixCommandFixture(logPath, includeElectronRunAsNode), { mode: 0o755 })
  await chmod(path, 0o755)
  return path
}

async function readCommandLog(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).replace(/\r\n?/g, '\n').trim().split('\n')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('installWeworkCli', () => {
  test('materializes a portable launcher into the Wework runtime path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-'))
    directories.push(root)
    const runtimeBin = join(root, 'runtime', 'bin')
    const cliSourcePath = join(root, 'wework-cli-source.mjs')
    await writeFile(cliSourcePath, '#!/usr/bin/env node\n')

    const cliPath = await installWeworkCli(runtimeBin, cliSourcePath, 'darwin', {
      appCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
      nodeCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
    })

    expect(cliPath).toBe(join(runtimeBin, 'wework'))
    await expect(access(cliPath)).resolves.toBeUndefined()
    await expect(access(join(runtimeBin, 'wework-cli.mjs'))).resolves.toBeUndefined()
    const launcher = await readFile(join(runtimeBin, 'wework'), 'utf8')
    expect(launcher).toContain('# Wework CLI launcher')
    expect(launcher).toMatch(/wework-cli\.mjs' "\$@"/)
    expect(launcher).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(launcher).toContain('--open-workspace "$ABSOLUTE_PATH"')
  })

  test('dispatches workspace paths and every CLI namespace without losing argument boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-dispatch-'))
    directories.push(root)
    const runtimeBin = join(root, 'runtime', 'bin')
    const workspace = join(root, 'project with spaces & quotes')
    const appLog = join(root, 'app.log')
    const nodeLog = join(root, 'node.log')
    const cliSourcePath = join(root, 'wework-cli-source.mjs')
    await mkdir(workspace)
    await writeFile(cliSourcePath, '#!/usr/bin/env node\n')

    // process.execPath is the packaged Wework/Electron executable when tests run
    // inside Wework. Passing it as the fake app would launch the real application,
    // which persists this temporary workspace as a local project.
    const appCommand = await createCommandFixture(root, 'fake-app', appLog, true)
    const nodeCommand = await createCommandFixture(root, 'fake-node', nodeLog, false)

    await installWeworkCli(runtimeBin, cliSourcePath, process.platform, {
      appCommand: [appCommand],
      nodeCommand: [nodeCommand],
    })

    const env = {
      ...process.env,
      CODEX_HOME: join(root, 'codex-home'),
      ELECTRON_RUN_AS_NODE: '1',
      WEWORK_USER_DATA_DIR: join(root, 'user-data'),
    }

    const launcher = join(runtimeBin, process.platform === 'win32' ? 'wework.cmd' : 'wework')
    for (const args of [
      ['desktop', 'instances'],
      ['smart-app', 'inspect', '--project', workspace],
      ['workbench', 'install', '--project', workspace],
    ]) {
      const command = resolveSpawnCommand(launcher, args)
      await execFileAsync(command.command, command.args, { env })
      expect(await readCommandLog(nodeLog)).toEqual([join(runtimeBin, 'wework-cli.mjs'), ...args])
    }

    const open = resolveSpawnCommand(launcher, [workspace])
    await execFileAsync(open.command, open.args, { env })
    expect(await readCommandLog(appLog)).toEqual([
      'unset',
      '--open-workspace',
      await realpath(workspace),
    ])

    const current = resolveSpawnCommand(launcher, [])
    await execFileAsync(current.command, current.args, { cwd: workspace, env })
    expect(await readCommandLog(appLog)).toEqual([
      'unset',
      '--open-workspace',
      await realpath(workspace),
    ])
  }, 15_000)

  test('binds the private CLI even after a shell profile puts an unrelated launcher first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-identity-'))
    directories.push(root)
    const privateBin = join(root, 'current instance')
    const globalBin = join(root, 'old global')
    const executable = process.platform === 'win32' ? 'wework.cmd' : 'wework'
    await mkdir(globalBin)
    await writeFile(
      join(globalBin, executable),
      process.platform === 'win32' ? '@exit /b 97\r\n' : '#!/bin/sh\nexit 97\n'
    )
    await chmod(join(globalBin, executable), 0o700)
    const cliPath = await installWeworkCli(
      privateBin,
      fileURLToPath(new URL('../cli/wework-cli.mjs', import.meta.url)),
      process.platform,
      { appCommand: [process.execPath], nodeCommand: [process.execPath] }
    )
    const environment = withWeworkCliEnvironment(
      { ...process.env, WEWORK_CLI_PATH: join(globalBin, executable) },
      cliPath,
      process.platform
    )
    const windows = process.platform === 'win32'
    const runner = join(root, 'profile.cmd')
    if (windows) {
      await writeFile(
        runner,
        `@echo off\r\nset "PATH=${globalBin};%PATH%"\r\nwhere wework.cmd\r\ncall "%WEWORK_CLI_PATH%" workbench --help\r\nexit /b %errorlevel%\r\n`
      )
    }
    const command = windows
      ? resolveSpawnCommand(runner, [])
      : {
          command: '/bin/sh',
          args: [
            '-c',
            'PATH="$1:$PATH"; export PATH; command -v wework; "$WEWORK_CLI_PATH" workbench --help',
            'sh',
            globalBin,
          ],
        }
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      env: environment,
    })
    expect(stdout.trim().split(/\r?\n/)[0]).toBe(join(globalBin, executable))
    expect(stderr).toContain('wework workbench install --project ABSOLUTE_PATH')
  })

  test('rejects a failed private installation instead of returning a usable CLI identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-failure-'))
    directories.push(root)
    await expect(
      installWeworkCli(root, join(root, 'missing.mjs'), process.platform, {
        appCommand: [process.execPath],
        nodeCommand: [process.execPath],
      })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(join(root, process.platform === 'win32' ? 'wework.cmd' : 'wework'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    ['--help'],
    ['-h'],
    ['desktop', '--help'],
    ['smart-app', '--help'],
    ['workbench', '--help'],
  ])('uses the actual CLI help for %j', async (...args) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-help-'))
    directories.push(root)
    const cliSourcePath = fileURLToPath(new URL('../cli/wework-cli.mjs', import.meta.url))
    await installWeworkCli(root, cliSourcePath, process.platform, {
      appCommand: [process.execPath, '--invalid-workspace-launch'],
      nodeCommand: [process.execPath],
    })
    const launcher = join(root, process.platform === 'win32' ? 'wework.cmd' : 'wework')
    const command = resolveSpawnCommand(launcher, args)
    const { stderr } = await execFileAsync(command.command, command.args)
    for (const namespace of ['desktop', 'smart-app', 'workbench']) {
      expect(stderr).toContain(`wework ${namespace}`)
    }
    expect(stderr).toContain('wework [path]')
  })

  test.each([
    { namespace: 'desktop', code: 1, error: 'No running Wework desktop instance was found' },
    { namespace: 'smart-app', code: 1, error: 'Unknown smart-app command: unsupported' },
    { namespace: 'workbench', code: 1, error: 'Unknown workbench command: unsupported' },
  ])('preserves the actual $namespace CLI failure status', async ({ namespace, code, error }) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-status-'))
    directories.push(root)
    const cliSourcePath = fileURLToPath(new URL('../cli/wework-cli.mjs', import.meta.url))
    await installWeworkCli(root, cliSourcePath, process.platform, {
      appCommand: [process.execPath, '--invalid-workspace-launch'],
      nodeCommand: [process.execPath],
    })
    const launcher = join(root, process.platform === 'win32' ? 'wework.cmd' : 'wework')
    const command = resolveSpawnCommand(launcher, [namespace, 'unsupported'])
    await expect(
      execFileAsync(command.command, command.args, {
        env: { ...process.env, WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: join(root, 'instances') },
      })
    ).rejects.toMatchObject({
      code,
      stderr: expect.stringContaining(error),
    })
  })
})

describe('withWeworkCliEnvironment', () => {
  test.each(['darwin', 'win32'] as const)(
    'replaces inherited CLI identity while retaining Node and Python settings on %s',
    platform => {
      const windows = platform === 'win32'
      const cliPath = windows
        ? win32.resolve('C:\\current instance', 'wework.cmd')
        : '/current instance/wework'
      const runtimeBin = windows ? 'C:\\node' : '/node'
      const inherited = {
        WEWORK_CLI_PATH: windows ? 'C:\\old\\wework.cmd' : '/old/wework',
        PATH: runtimeBin,
        WEWORK_NODE_PATH: join(runtimeBin, 'node'),
        WEGENT_PYTHON_PATH: '/managed/python3',
      }
      const environment = withWeworkCliEnvironment(inherited, cliPath, platform)
      expect(environment.WEWORK_CLI_PATH).toBe(cliPath)
      expect(environment.WEWORK_NODE_PATH).toBe(inherited.WEWORK_NODE_PATH)
      expect(environment.WEGENT_PYTHON_PATH).toBe(inherited.WEGENT_PYTHON_PATH)
      expect(environment.PATH?.split(windows ? ';' : ':')).toEqual([
        (windows ? win32 : posix).dirname(cliPath),
        runtimeBin,
      ])
      expect(withWeworkCliEnvironment(environment, cliPath, platform)).toEqual(environment)
      expect(inherited.WEWORK_CLI_PATH).not.toBe(cliPath)
    }
  )

  test('rejects a relative instance identity', () => {
    expect(() => withWeworkCliEnvironment({}, 'wework', process.platform)).toThrow(
      'must be absolute'
    )
  })
})

describe('shouldInstallUserWeworkCli', () => {
  test('installs the user launcher only from a normal packaged macOS instance', () => {
    expect(
      shouldInstallUserWeworkCli('darwin', {
        environment: {},
        packagedApplication: true,
        pluginDevelopmentInstance: false,
      })
    ).toBe(true)
    expect(
      shouldInstallUserWeworkCli('darwin', {
        environment: { WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234' },
        packagedApplication: true,
        pluginDevelopmentInstance: false,
      })
    ).toBe(false)
    expect(
      shouldInstallUserWeworkCli('darwin', {
        environment: {},
        packagedApplication: true,
        pluginDevelopmentInstance: true,
      })
    ).toBe(false)
    expect(
      shouldInstallUserWeworkCli('win32', {
        environment: {},
        packagedApplication: true,
        pluginDevelopmentInstance: false,
      })
    ).toBe(false)
  })
})
