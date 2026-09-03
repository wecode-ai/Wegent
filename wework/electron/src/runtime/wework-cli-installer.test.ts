import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { installWeworkCli } from './wework-cli-installer.js'

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
    const source = resolve(process.cwd(), 'electron/src/cli/wework-cli.mjs')

    await installWeworkCli(runtimeBin, source, 'darwin', {
      appCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
      nodeCommand: ['/Applications/Wework.app/Contents/MacOS/Wework'],
    })

    await expect(access(join(runtimeBin, 'wework-cli.mjs'))).resolves.toBeUndefined()
    const launcher = await readFile(join(runtimeBin, 'wework'), 'utf8')
    expect(launcher).toContain('# Wework CLI launcher')
    expect(launcher).toContain('if [ "${1:-}" = "desktop" ]')
    expect(launcher).toMatch(/wework-cli\.mjs' "\$@"/)
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
    await mkdir(workspace)
    await writeFile(appCommand, `#!/bin/sh\nprintf '%s\\n' "$@" > '${appLog}'\n`)
    await writeFile(nodeCommand, `#!/bin/sh\nprintf '%s\\n' "$@" > '${nodeLog}'\n`)
    await Promise.all([chmod(appCommand, 0o700), chmod(nodeCommand, 0o700)])

    await installWeworkCli(
      runtimeBin,
      resolve(process.cwd(), 'electron/src/cli/wework-cli.mjs'),
      'darwin',
      {
        appCommand: [appCommand],
        nodeCommand: [nodeCommand],
      }
    )

    const launcher = join(runtimeBin, 'wework')
    await execFileAsync(launcher, ['desktop', 'instances'])
    expect((await readFile(nodeLog, 'utf8')).trim().split('\n')).toEqual([
      join(runtimeBin, 'wework-cli.mjs'),
      'desktop',
      'instances',
    ])

    await execFileAsync(launcher, [workspace])
    expect((await readFile(appLog, 'utf8')).trim().split('\n')).toEqual([
      '--open-workspace',
      await realpath(workspace),
    ])
  })
})
