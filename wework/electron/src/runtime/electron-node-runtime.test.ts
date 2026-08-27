import { lstat, readlink } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { prepareElectronNodeRuntime, runtimeNodeArgs } from './electron-node-runtime.js'

describe('prepareElectronNodeRuntime', () => {
  test('exposes Electron Node through a PATH launcher', async () => {
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
      'dsh.js',
    ])
    expect(runtime.status).toMatchObject({
      state: 'installed',
      source: 'electron',
      version: '24.13.0',
      path: nodePath,
    })
    expect((await lstat(nodePath)).isSymbolicLink()).toBe(true)
    expect(await readlink(nodePath)).toBe(helperExecPath)
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
})
