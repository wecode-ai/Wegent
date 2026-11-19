import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packagerRequire = createRequire(require.resolve('@electron/packager'))
const { createPackage } = await import(
  pathToFileURL(packagerRequire.resolve('@electron/asar')).href
)

// The suite can run inside the project's own Electron runtime host, whose
// asar-patched fs cannot delete .asar paths. Remove the fixture tree from an
// isolated child with ASAR disabled, mirroring removePhysicalRelease (#4740).
function removeFixtureTree(path) {
  return promisify(execFile)(
    require('electron'),
    [
      '--input-type=commonjs',
      '--eval',
      'process.noAsar = true\nrequire("node:fs").rmSync(process.argv[1], { recursive: true, force: true })',
      path,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }
  )
}

test('copies physical ASAR bytes without disabling ASAR in the running Electron process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-physical-asar-'))
  try {
    await mkdir(join(root, 'content'))
    await writeFile(join(root, 'content', 'fixture.txt'), 'physical archive regression')
    const source = join(root, 'source.asar')
    const target = join(root, 'target.asar')
    await createPackage(join(root, 'content'), source)
    const module = pathToFileURL(resolve('src/runtime/physical-release-files.ts')).href
    const script = `
      import {stat} from 'node:fs/promises'
      const {copyPhysicalRelease} = await import(${JSON.stringify(module)})
      const source = ${JSON.stringify(source)}
      const before = (await stat(source)).isDirectory()
      await copyPhysicalRelease(source, ${JSON.stringify(target)})
      console.log(JSON.stringify({before, after:(await stat(source)).isDirectory()}))
    `
    const { stdout } = await promisify(execFile)(
      require('electron'),
      ['--input-type=module', '--eval', script],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
      }
    )
    expect(JSON.parse(stdout.trim())).toEqual({ before: true, after: true })
    // Physical-byte assertions must run outside any asar-patched process: the
    // host runtime sees .asar paths as virtual directories (#4740).
    const { stdout: probe } = await promisify(execFile)(
      require('electron'),
      [
        '--input-type=commonjs',
        '--eval',
        'process.noAsar = true\nconst fs = require("node:fs")\nconst crypto = require("node:crypto")\nconst [targetPath, sourcePath] = process.argv.slice(1)\nconst digest = path => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex")\nconsole.log(JSON.stringify({ isFile: fs.statSync(targetPath).isFile(), identical: digest(targetPath) === digest(sourcePath) }))',
        target,
        source,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }
    )
    expect(JSON.parse(probe.trim())).toEqual({ isFile: true, identical: true })
    await removeFixtureTree(root)
  } catch (error) {
    try {
      await removeFixtureTree(root)
    } catch (cleanupError) {
      console.error('Fixture cleanup failed after test failure:', cleanupError)
    }
    throw error
  }
}, 35_000)

test('copies a release tree with independent bytes, private modes and relative links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-physical-tree-'))
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    await mkdir(join(source, 'private'), { recursive: true })
    await writeFile(join(source, 'private', 'payload'), 'immutable source bytes')
    if (process.platform !== 'win32') {
      await chmod(join(source, 'private'), 0o700)
      await chmod(join(source, 'private', 'payload'), 0o600)
      await symlink('private/payload', join(source, 'linked'))
    }
    const module = pathToFileURL(resolve('src/runtime/physical-release-files.ts')).href
    await promisify(execFile)(
      require('electron'),
      [
        '--input-type=module',
        '--eval',
        `
      const {copyPhysicalRelease} = await import(${JSON.stringify(module)})
      await copyPhysicalRelease(${JSON.stringify(source)}, ${JSON.stringify(target)})
    `,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }
    )
    const payload = join(target, 'private', 'payload')
    expect(await readFile(payload, 'utf8')).toBe('immutable source bytes')
    if (process.platform !== 'win32') {
      expect((await stat(join(target, 'private'))).mode & 0o777).toBe(0o700)
      expect((await stat(payload)).mode & 0o777).toBe(0o600)
      expect((await lstat(join(target, 'linked'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(target, 'linked'))).toBe('private/payload')
    }
    await writeFile(payload, 'target mutation')
    expect(await readFile(join(source, 'private', 'payload'), 'utf8')).toBe(
      'immutable source bytes'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 35_000)
