import { ZipArchive } from 'archiver'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

test('Electron extracts a deflated Smart App asset through EOF under backpressure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-zip-runtime-'))
  // Repeated hash blocks expand enough to apply inflate backpressure while the
  // compressed entry exceeds both Windows and macOS stream high water marks.
  const content = Array.from({ length: 4096 }, (_, index) =>
    createHash('sha256').update(String(index)).digest('hex').repeat(4)
  ).join('\n')
  const archivePath = join(root, 'smart-app.zip')
  const destination = join(root, 'extracted')
  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(archivePath)
      const archive = new ZipArchive({ zlib: { level: 9 } })
      output.once('close', resolve)
      output.once('error', reject)
      archive.once('error', reject)
      archive.pipe(output)
      archive.append(content, { name: 'terminal-workbench/lib/client.js' })
      void archive.finalize()
    })
    expect((await readFile(archivePath)).byteLength).toBeGreaterThan(128 * 1024)

    await run(
      require('electron') as string,
      [
        '--experimental-transform-types',
        '--input-type=module',
        '-e',
        `import(process.argv[1])
          .then(({ extractSmartAppArchive }) => extractSmartAppArchive(process.argv[2], process.argv[3]))
          .then(() => console.log('extracted'))
          .catch(error => { console.error(error); process.exitCode = 1 })`,
        new URL('./smart-app-package-validator.ts', import.meta.url).href,
        archivePath,
        destination,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000 }
    ).then(({ stdout }) => expect(stdout.trim()).toBe('extracted'))

    expect(await readFile(join(destination, 'terminal-workbench/lib/client.js'), 'utf8')).toBe(
      content
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
