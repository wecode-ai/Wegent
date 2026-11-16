import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
    expect((await stat(target)).isFile()).toBe(true)
    const digest = async path =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    expect(await digest(target)).toBe(await digest(source))
  } finally {
    await rm(root, { recursive: true, force: true })
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
