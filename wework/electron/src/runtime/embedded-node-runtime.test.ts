import { mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { embeddedNodeArguments, prepareEmbeddedNodeEnvironment } from './embedded-node-runtime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

describe('prepareEmbeddedNodeEnvironment', () => {
  test('exposes Electron as node and puts its launcher first on PATH', async () => {
    const dataDirectory = await temporaryDirectory()
    const environment = await prepareEmbeddedNodeEnvironment({
      electronExecutable: process.execPath,
      dataDirectory,
      environment: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'darwin',
    })
    const launcher = join(dataDirectory, 'managed-runtimes', 'electron-node', 'bin', 'node')

    expect(environment.WEWORK_NODE_PATH).toBe(process.execPath)
    expect(environment.NODE).toBe(process.execPath)
    expect(environment.npm_node_execpath).toBe(process.execPath)
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(environment.PATH?.split(delimiter)[0]).toBe(join(launcher, '..'))
    expect(await readlink(launcher)).toBe(process.execPath)
  })

  test('creates a Windows command launcher without a standalone Node runtime', async () => {
    const dataDirectory = await temporaryDirectory()
    const electronExecutable = 'C:\\Program Files\\WeWork\\WeWork.exe'
    await prepareEmbeddedNodeEnvironment({
      electronExecutable,
      dataDirectory,
      environment: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
    })
    const launcher = join(dataDirectory, 'managed-runtimes', 'electron-node', 'bin', 'node.cmd')

    expect((await stat(launcher)).isFile()).toBe(true)
    expect(await readFile(launcher, 'utf8')).toContain(`"${electronExecutable}" %*`)
  })

  test('exposes Node internals only for Electron-as-Node launches', () => {
    expect(embeddedNodeArguments({ ELECTRON_RUN_AS_NODE: '1' }, ['entry.js'])).toEqual([
      '--expose-internals',
      'entry.js',
    ])
    expect(embeddedNodeArguments({}, ['entry.js'])).toEqual(['entry.js'])
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wework-electron-node-'))
  temporaryDirectories.push(path)
  return path
}
