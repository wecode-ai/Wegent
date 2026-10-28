import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
