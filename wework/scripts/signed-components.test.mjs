import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { reuseSignedComponent } from '../electron/scripts/prepare-signed-components.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
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
