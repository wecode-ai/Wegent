import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

import {
  prepareElectronNodeRuntime,
  resolveConfiguredNodePath,
  runtimeNodeArgs,
} from './electron-node-runtime.js'

const execFileAsync = promisify(execFile)

describe('prepareElectronNodeRuntime', () => {
  test('exposes Electron Helper through a self-contained PATH launcher', async () => {
    const directory = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/wework-node-'))
    const helperExecPath =
      '/Applications/WeWork.app/Contents/Frameworks/WeWork Helper.app/Contents/MacOS/WeWork Helper'

    const runtime = await prepareElectronNodeRuntime({
      dataDirectory: directory,
      environment: { PATH: '/usr/bin:/bin' },
      helperExecPath,
      nodeVersion: '24.13.0',
      platform: 'darwin',
    })

    const nodePath = join(directory, 'runtime', 'bin', 'node')
    expect(runtime.environment.WEWORK_NODE_PATH).toBe(nodePath)
    expect(runtime.environment.WEWORK_RUNTIME_BIN).toBe(join(directory, 'runtime', 'bin'))
    expect(runtime.environment.PATH?.split(delimiter)[0]).toBe(join(directory, 'runtime', 'bin'))
    expect(runtime.environment.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(runtime.environment.WEWORK_NODE_RUNTIME_KIND).toBe('electron')
    expect(runtimeNodeArgs(runtime.environment, ['dsh.js'])).toEqual([
      '--expose-internals',
      '--require',
      join(directory, 'runtime', 'bin', 'electron-node-bootstrap.cjs'),
      'dsh.js',
    ])
    expect(runtime.status).toMatchObject({
      state: 'installed',
      source: 'electron',
      version: '24.13.0',
      path: nodePath,
    })
    expect((await stat(nodePath)).isFile()).toBe(true)
    expect(await readFile(nodePath, 'utf8')).toContain('export ELECTRON_RUN_AS_NODE=1')
    expect(await readFile(nodePath, 'utf8')).toContain(`exec '${helperExecPath}' --require`)
    expect(await readFile(nodePath, 'utf8')).toContain(
      `--require '${join(directory, 'runtime', 'bin', 'electron-node-bootstrap.cjs')}'`
    )
  })

  test('preserves an explicitly configured Node executable', async () => {
    const runtime = await prepareElectronNodeRuntime({
      dataDirectory: '/unused',
      environment: {
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        WEWORK_NODE_RUNTIME_KIND: 'electron',
        WEWORK_NODE_PATH: '/managed/node',
      },
      helperExecPath: '/Applications/WeWork.app/Contents/MacOS/WeWork Helper',
      nodeVersion: '24.13.0',
      platform: 'darwin',
    })

    expect(runtime.environment.WEWORK_NODE_PATH).toBe('/managed/node')
    expect(runtime.environment.WEWORK_RUNTIME_BIN).toBe('/managed')
    expect(runtime.environment.PATH?.split(delimiter)[0]).toBe('/managed')
    expect(runtime.environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(runtime.environment.WEWORK_NODE_RUNTIME_KIND).toBeUndefined()
    expect(runtimeNodeArgs(runtime.environment, ['skill.js'])).toEqual(['skill.js'])
    expect(runtime.status.source).toBe('configured')
  })

  test.skipIf(process.platform === 'win32')(
    'does not depend on the parent ELECTRON_RUN_AS_NODE environment',
    async () => {
      const directory = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/wework-node-'))
      const runtime = await prepareElectronNodeRuntime({
        dataDirectory: directory,
        environment: { PATH: process.env.PATH },
        helperExecPath: process.execPath,
        nodeVersion: process.version,
        platform: process.platform,
      })
      const environment = { ...process.env }
      delete environment.ELECTRON_RUN_AS_NODE

      const result = await execFileAsync(
        runtime.environment.WEWORK_NODE_PATH!,
        ['-e', "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? 'missing')"],
        {
          env: environment,
        }
      )

      expect(result.stdout).toBe('1')
    }
  )

  test.skipIf(process.platform === 'win32')(
    'keeps Electron Node children alive when their diagnostic pipe closes',
    async () => {
      const directory = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/wework-node-'))
      const runtime = await prepareElectronNodeRuntime({
        dataDirectory: directory,
        environment: { PATH: process.env.PATH },
        helperExecPath: process.execPath,
        nodeVersion: process.version,
        platform: process.platform,
      })
      const child = spawn(
        runtime.environment.WEWORK_NODE_PATH!,
        [
          '-e',
          [
            "process.stdin.once('data', () => {",
            "  process.emitWarning('closed diagnostic pipe')",
            "  setTimeout(() => process.stdout.write('survived'), 50)",
            '})',
          ].join('\n'),
        ],
        {
          env: runtime.environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      )

      const stdout = new Promise<string>((resolve, reject) => {
        let output = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => {
          output += chunk
        })
        child.once('error', reject)
        child.once('close', code => {
          if (code === 0) resolve(output)
          else reject(new Error(`Electron Node child exited with ${code}`))
        })
      })
      const stderrClosed = new Promise<void>(resolve => {
        child.stderr.once('close', resolve)
      })
      child.stderr.destroy()
      await stderrClosed
      child.stdin.end('warn')

      await expect(stdout).resolves.toBe('survived')
    }
  )

  test.skipIf(process.platform === 'win32')(
    'replaces a stale symlink without modifying its Helper target',
    async () => {
      const directory = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/wework-node-'))
      const helperExecPath = join(directory, 'Electron Helper')
      const launcherPath = join(directory, 'runtime', 'bin', 'node')
      await writeFile(helperExecPath, 'packaged Electron Helper')
      await mkdir(join(directory, 'runtime', 'bin'), { recursive: true })
      await symlink(helperExecPath, launcherPath)

      await prepareElectronNodeRuntime({
        dataDirectory: directory,
        environment: { PATH: process.env.PATH },
        helperExecPath,
        nodeVersion: process.version,
        platform: process.platform,
      })

      expect(await readFile(helperExecPath, 'utf8')).toBe('packaged Electron Helper')
      expect((await stat(launcherPath)).isFile()).toBe(true)
      expect(await readFile(launcherPath, 'utf8')).toContain('export ELECTRON_RUN_AS_NODE=1')
    }
  )

  test('treats an explicit built-in preference as authoritative', () => {
    expect(
      resolveConfiguredNodePath(
        { nodeExecutablePath: null },
        { WEWORK_NODE_PATH: '/inherited/node' }
      )
    ).toBeNull()
    expect(
      resolveConfiguredNodePath(
        { nodeExecutablePath: ' /configured/node ' },
        { WEWORK_NODE_PATH: '/inherited/node' }
      )
    ).toBe('/configured/node')
    expect(resolveConfiguredNodePath({}, { WEWORK_NODE_PATH: ' /inherited/node ' })).toBe(
      '/inherited/node'
    )
  })

  test('creates a Windows command launcher while executing the Helper directly', async () => {
    const directory = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/wework-node-'))
    const helperExecPath = 'C:\\Program Files\\WeWork\\WeWork Helper.exe'

    const runtime = await prepareElectronNodeRuntime({
      dataDirectory: directory,
      environment: {
        Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
      },
      helperExecPath,
      nodeVersion: '24.13.0',
      platform: 'win32',
    })

    const launcherPath = join(directory, 'runtime', 'bin', 'node.cmd')
    expect(runtime.environment.WEWORK_NODE_PATH).toBe(helperExecPath)
    expect(await readFile(launcherPath, 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(await readFile(launcherPath, 'utf8')).toContain(`"${helperExecPath}" --require`)
    expect(await readFile(launcherPath, 'utf8')).toContain(
      `--require "${join(directory, 'runtime', 'bin', 'electron-node-bootstrap.cjs')}"`
    )
    expect(runtime.environment.Path).toBeUndefined()
    expect(runtime.environment.PATH?.split(';')).toEqual([
      join(directory, 'runtime', 'bin'),
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
    ])
  })

  test('normalizes the Windows PATH key for a configured Node executable', async () => {
    const runtime = await prepareElectronNodeRuntime({
      dataDirectory: '/unused',
      environment: {
        Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
        WEWORK_NODE_PATH: 'C:\\Program Files\\nodejs\\node.exe',
      },
      helperExecPath: 'C:\\Program Files\\WeWork\\WeWork Helper.exe',
      nodeVersion: '24.13.0',
      platform: 'win32',
    })

    expect(runtime.environment.Path).toBeUndefined()
    expect(runtime.environment.PATH?.split(';')).toEqual([
      'C:\\Program Files\\nodejs',
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
    ])
    expect(runtime.environment.WEWORK_RUNTIME_BIN).toBe('C:\\Program Files\\nodejs')
  })
})
