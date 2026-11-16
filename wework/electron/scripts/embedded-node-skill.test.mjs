import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { prepareElectronNodeRuntime } from '../src/runtime/electron-node-runtime.ts'
import { verifyEmbeddedNodeSkillRuntime } from '../../e2e/desktop/scenarios/release-package-startup.scenario.mjs'

const electronPackage = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
)

let directory
let binDirectory

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wework node skill-'))
  const runtime = await prepareElectronNodeRuntime({
    dataDirectory: directory,
    environment: { PATH: process.env.PATH },
    helperExecPath: process.execPath,
    nodeVersion: process.versions.node,
    platform: process.platform,
  })
  binDirectory = runtime.environment.WEWORK_RUNTIME_BIN
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function setElectronVersion(version) {
  // Use real launcher and child-process execution with a synthetic Electron fingerprint.
  await appendFile(
    join(binDirectory, 'electron-node-bootstrap.cjs'),
    `\nObject.defineProperty(process.versions, 'electron', { value: ${JSON.stringify(version)} })\n`
  )
}

test('executes the generated runtime launcher and records the verified versions', async () => {
  await setElectronVersion(electronPackage.devDependencies.electron)

  await verifyEmbeddedNodeSkillRuntime(directory, directory)

  expect(
    JSON.parse(await readFile(join(directory, 'embedded-node-versions.json'), 'utf8'))
  ).toEqual({
    electron: electronPackage.devDependencies.electron,
    node: process.versions.node,
    availableMemoryBytes: expect.any(Number),
  })
})

test('rejects a missing launcher before a system Node can be selected from PATH', async () => {
  await rm(join(binDirectory, process.platform === 'win32' ? 'node.cmd' : 'node'))

  await expect(verifyEmbeddedNodeSkillRuntime(directory, directory)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test.each([undefined, '43.4.1'])(
  'rejects a launcher reporting an incompatible Electron version: %s',
  async version => {
    if (version) await setElectronVersion(version)

    await expect(verifyEmbeddedNodeSkillRuntime(directory, directory)).rejects.toMatchObject({
      code: 'ERR_ASSERTION',
      expected: electronPackage.devDependencies.electron,
    })
  }
)
