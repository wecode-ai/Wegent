import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { installWeworkCli, shouldInstallUserWeworkCli } from './wework-cli-installer.js'

const directories: string[] = []
const execFileAsync = promisify(execFile)

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
    const appCommand = join(root, 'app')
    const nodeCommand = join(root, 'node')
    const cliSourcePath = join(root, 'wework-cli-source.mjs')
    await mkdir(workspace)
    await writeFile(cliSourcePath, '#!/usr/bin/env node\n')
    await writeFile(
      appCommand,
      `#!/bin/sh\nprintf '%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}" "$@" > '${appLog}'\n`
    )
    await writeFile(nodeCommand, `#!/bin/sh\nprintf '%s\\n' "$@" > '${nodeLog}'\n`)
    await Promise.all([chmod(appCommand, 0o700), chmod(nodeCommand, 0o700)])

    await installWeworkCli(runtimeBin, cliSourcePath, 'darwin', {
      appCommand: [appCommand],
      nodeCommand: [nodeCommand],
    })

    const launcher = join(runtimeBin, 'wework')
    await execFileAsync(launcher, ['desktop', 'instances'])
    expect((await readFile(nodeLog, 'utf8')).trim().split('\n')).toEqual([
      join(runtimeBin, 'wework-cli.mjs'),
      'desktop',
      'instances',
    ])

    await execFileAsync(launcher, [workspace], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect((await readFile(appLog, 'utf8')).trim().split('\n')).toEqual([
      'unset',
      '--open-workspace',
      await realpath(workspace),
    ])
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
