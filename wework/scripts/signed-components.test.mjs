import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { reuseSignedComponent } from '../electron/scripts/prepare-signed-components.mjs'
import { executeMacOsCodesign } from './lib/deepseek-harness-signing.mjs'

const roots = []

test.each([
  'The timestamp service is not available.',
  'A timestamp was expected but was not found.',
])('never publishes a signed cache after persistent %s', async message => {
  const root = await mkdtemp(join(tmpdir(), 'wework-signing-failed-'))
  roots.push(root)
  const source = join(root, 'executor')
  const cacheRoot = join(root, 'cache')
  await writeFile(source, 'unsigned executor')
  await mkdir(cacheRoot)
  const error = Object.assign(new Error('codesign failed'), {
    stderr: `${source}: ${message}`,
  })
  const execute = vi.fn().mockRejectedValue(error)
  const verify = vi.fn()
  await expect(
    reuseSignedComponent({
      source,
      cacheRoot,
      identity: 'certificate',
      policy: {},
      sign: file =>
        executeMacOsCodesign(['--sign', 'certificate', '--timestamp', file], {
          execute,
          sleepImpl: vi.fn().mockResolvedValue(undefined),
          logger: vi.fn(),
        }),
      verify,
    })
  ).rejects.toBe(error)
  expect(execute).toHaveBeenCalledTimes(3)
  expect(verify).not.toHaveBeenCalled()
  expect(await readdir(cacheRoot)).toEqual([])
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('preserves relative dependency links when restoring a signed runtime component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-signed-runtime-'))
  roots.push(root)
  const source = join(root, 'runtime')
  const seed = async () => {
    await mkdir(join(source, 'store'), { recursive: true })
    await writeFile(join(source, 'store', 'package.js'), 'runtime')
    await symlink('store/package.js', join(source, 'package.js'))
  }
  await seed()
  const sign = vi.fn(async () => {})
  const verify = vi.fn(async () => {})
  const options = {
    source,
    cacheRoot: join(root, 'cache'),
    identity: 'certificate',
    policy: {},
    sign,
    verify,
  }
  const hash = await reuseSignedComponent(options)
  await rm(source, { recursive: true })
  await seed()
  expect(await reuseSignedComponent(options)).toBe(hash)
  expect(await readlink(join(source, 'package.js'))).toBe('store/package.js')
  expect(await readFile(join(source, 'package.js'), 'utf8')).toBe('runtime')
  expect(sign).toHaveBeenCalledOnce()
})

test('reuses signed bytes across application releases, and invalidates on content or signing policy changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-signed-'))
  roots.push(root)
  const source = join(root, 'dws')
  let timestamp = 0
  const sign = vi.fn(async file =>
    writeFile(file, `${await readFile(file, 'utf8')}:signature-${++timestamp}`)
  )
  const verify = vi.fn(async file => {
    expect(await readFile(file, 'utf8')).toContain(':signature-')
  })
  const options = {
    source,
    cacheRoot: join(root, 'cache'),
    identity: 'certificate',
    policy: { version: 1 },
    sign,
    verify,
  }
  await writeFile(source, 'dws-v1')
  const first = await reuseSignedComponent(options)
  await writeFile(source, 'dws-v1')
  expect(await reuseSignedComponent(options)).toBe(first)
  expect(sign).toHaveBeenCalledTimes(1)
  expect(await readFile(source, 'utf8')).toBe('dws-v1:signature-1')
  await writeFile(source, 'dws-v2')
  expect(await reuseSignedComponent(options)).not.toBe(first)
  await writeFile(source, 'dws-v1')
  await reuseSignedComponent({ ...options, identity: 'new-certificate' })
  expect(sign).toHaveBeenCalledTimes(3)
  await writeFile(source, 'dws-v1')
  await reuseSignedComponent({ ...options, policy: { version: 2 } })
  expect(sign).toHaveBeenCalledTimes(4)
})
