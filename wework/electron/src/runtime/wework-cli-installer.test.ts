import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { installWeworkCli, shouldInstallUserWeworkCli } from './wework-cli-installer.js'
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

    await installWeworkCli(runtimeBin, cliSourcePath, 'darwin', {
      appCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
      nodeCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
    })

    await expect(access(join(runtimeBin, 'wework-cli.mjs'))).resolves.toBeUndefined()
    const launcher = await readFile(join(runtimeBin, 'wework'), 'utf8')
    expect(launcher).toContain('# Wework CLI launcher')
    expect(launcher).toContain('if [ "${1:-}" = "desktop" ]')
    expect(launcher).toMatch(/wework-cli\.mjs' "\$@"/)
    expect(launcher).toContain('unset ELECTRON_RUN_AS_NODE')
    expect(launcher).toContain('--open-workspace "$ABSOLUTE_PATH"')
  })

  test('dispatches workspace paths and desktop commands through one launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cli-dispatch-'))
    directories.push(root)
    const runtimeBin = join(root, 'runtime', 'bin')
    const workspace = join(root, 'project')
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
    const desktop = resolveSpawnCommand(launcher, ['desktop', 'instances'])
    await execFileAsync(desktop.command, desktop.args, { env })
    expect((await readFile(nodeLog, 'utf8')).trim().split('\n')).toEqual([
      join(runtimeBin, 'wework-cli.mjs'),
      'desktop',
      'instances',
    ])

    const open = resolveSpawnCommand(launcher, [workspace])
    await execFileAsync(open.command, open.args, { env })
    expect((await readFile(appLog, 'utf8')).trim().split('\n')).toEqual([
      'unset',
      '--open-workspace',
      await realpath(workspace),
    ])
  }, 15_000)
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
