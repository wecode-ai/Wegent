import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const require = createRequire(new URL('../electron/package.json', import.meta.url))
const tar = require('tar')
const asset =
  'harness-runtime-windows-x64-dsh-0.2.0-rc.2-e67e5ad2e167baf839e1335ba88432b225bad15a3ecbe5fdd3c7ab5b269c6297'
const directory = await mkdtemp(join(tmpdir(), 'wework-runtime-profile-'))

async function measure(phase, operation) {
  const started = performance.now()
  const result = await operation()
  console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }))
  return result
}

try {
  assert.equal(process.platform, 'win32', 'This diagnostic requires a real Windows runner')
  await measure('download', () =>
    execute('gh', [
      'release',
      'download',
      'wework-updater',
      '--repo',
      'wecode-ai/Wegent',
      '--pattern',
      `${asset}.json`,
      '--pattern',
      `${asset}.tar.gz`,
      '--dir',
      directory,
    ])
  )
  const archive = join(directory, `${asset}.tar.gz`)
  const descriptor = JSON.parse(await readFile(join(directory, `${asset}.json`), 'utf8'))
  assert.equal((await stat(archive)).size, descriptor.archiveBytes)
  await measure('sha256', async () => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    assert.equal(hash.digest('hex'), descriptor.archiveSha256)
  })
  await measure('inflate-and-parse', () => tar.list({ file: archive, strict: true }))
  for (const mode of ['native', 'sync', 'async']) {
    const destination = join(directory, mode)
    await mkdir(destination)
    await measure(`extract-${mode}`, () =>
      mode === 'native'
        ? execute(join(process.env.SystemRoot, 'System32', 'tar.exe'), [
            '-xf',
            archive,
            '-C',
            destination,
          ])
        : tar.extract({ file: archive, cwd: destination, strict: true, sync: mode === 'sync' })
    )
    const identity = JSON.parse(await readFile(join(destination, 'runtime.json'), 'utf8'))
    assert.equal(identity.sourceFingerprint, descriptor.sourceFingerprint)
    const entries = await readdir(destination, { recursive: true, withFileTypes: true })
    console.log(JSON.stringify({ mode, files: entries.filter(entry => entry.isFile()).length }))
    await measure(`cleanup-${mode}`, () => rm(destination, { recursive: true, force: true }))
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
