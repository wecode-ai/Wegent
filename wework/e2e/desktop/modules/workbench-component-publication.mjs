import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Included in the Windows workbench-mode checkpoint using real packaged resources.
export async function verifyWindowsComponentPublication({ resources, environment, root }) {
  await mkdir(root, { recursive: true })
  const holder = join(root, 'hold-file.ps1')
  await writeFile(
    holder,
    `
param([string]$Path, [int]$ReleaseAfterMs = 0)
$handle = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
try {
  [Console]::Out.WriteLine('held')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
  if ($ReleaseAfterMs -gt 0) { [System.Threading.Thread]::Sleep($ReleaseAfterMs) }
} finally { $handle.Dispose() }
`
  )
  const script = join(root, 'publication.mjs')
  await writeFile(
    script,
    `
import assert from 'node:assert/strict'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const input = JSON.parse(process.argv[2])
app.setPath('userData', join(input.root, 'electron'))
const originalSymlink = fs.symlink
let child
let closed
let occupiedPublications = 0
async function holdFile(file, releaseAfterMs = 0) {
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', input.holder,
    '-Path', file, '-ReleaseAfterMs', String(releaseAfterMs)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  closed = new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept(code) : reject(new Error('Native holder failed')))
  })
  child.stderr.resume()
  await new Promise((accept, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Native file holder did not start')), 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', data => {
      output += data.toString()
      if (!output.includes(String.fromCharCode(10))) return
      clearTimeout(timer)
      output.trim() === 'held' ? accept() : reject(new Error('Invalid native holder acknowledgement'))
    })
  })
}
fs.symlink = async (source, target, type) => {
  if (basename(source).startsWith('.content-')) {
    const file = basename(dirname(target)) === 'wework-core-plugins'
      ? join('wework-app', 'client.js') : 'runtime.json'
    await holdFile(join(source, file))
    await assert.rejects(fs.rename(source, source + '.blocked'), error =>
      ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
    await originalSymlink(source, target, type)
    assert.equal(await fs.readFile(join(target, file), 'utf8'),
      await fs.readFile(join(source, file), 'utf8'))
    occupiedPublications++
    child.stdin.end()
    assert.equal(await closed, 0)
    child = null
    return
  }
  return originalSymlink(source, target, type)
}
syncBuiltinESMExports()
try {
  const { ComponentUpdateManager } = await import(pathToFileURL(join(input.resources,
    'app.asar/dist/runtime/component-update-manager.js')).href)
  const metadata = JSON.parse(await fs.readFile(join(input.resources, 'components.json'), 'utf8'))
  const options = { resourcesRoot: input.resources, dataDirectory: join(input.root, 'data'),
    currentAppVersion: metadata.appVersion, updateBaseUrl: 'http://127.0.0.1:1' }
  const paths = await new ComponentUpdateManager(options).prepareStartup()
  assert.equal(occupiedPublications, 1)
  assert.equal((await fs.lstat(paths.weworkCorePlugins)).isSymbolicLink(), true)
  const entries = await fs.readdir(join(input.root, 'data', 'managed-components', 'composed', 'wework-core-plugins'))
  const restart = await new ComponentUpdateManager(options).prepareStartup()
  assert.equal(restart.weworkCorePlugins, paths.weworkCorePlugins)
  assert.deepEqual(await fs.readdir(join(input.root, 'data', 'managed-components', 'composed', 'wework-core-plugins')), entries)
  const { materializeBundledRuntimes } = await import(pathToFileURL(join(input.resources,
    'app.asar/dist/runtime/bundled-runtime-materializer.js')).href)
  const runtimeRoot = join(input.root, 'runtimes')
  await materializeBundledRuntimes(join(input.resources, 'harness-runtime'), runtimeRoot, ['core'])
  assert.equal(occupiedPublications, 2)
  await materializeBundledRuntimes(join(input.resources, 'harness-runtime'), runtimeRoot, ['core'])
  assert.equal(occupiedPublications, 2)
  const { renameWorkbenchData } = await import(pathToFileURL(join(input.resources,
    'app.asar/dist/runtime/workbench-data-rename.js')).href)
  const journal = join(input.root, 'migration-journal.json')
  const pending = journal + '.tmp'
  await fs.writeFile(journal, 'pending')
  await fs.writeFile(pending, 'completed')
  await holdFile(journal, 250)
  assert.throws(() => fsSync.renameSync(pending, journal), error =>
    ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
  child.stdin.end('release' + String.fromCharCode(10))
  renameWorkbenchData(pending, journal)
  assert.equal(await closed, 0)
  child = null
  assert.equal(await fs.readFile(journal, 'utf8'), 'completed')
  await assert.rejects(fs.lstat(pending), { code: 'ENOENT' })
  process.stdout.write(JSON.stringify({ occupiedDirectoryRenameRejected: true,
    completeContentPublishedWhileOccupied: true, runtimePublishedWhileOccupied: true,
    restartReusedComposition: true, migrationJournalReplacedAfterHandleClosed: true }), () => app.exit(0))
} catch (error) {
  if (child) { child.kill(); await closed.catch(() => {}) }
  console.error(error.stack)
  app.exit(1)
}
`
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const env = { ...environment }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await promisify(execFile)(
    require('electron'),
    [script, JSON.stringify({ root, resources, holder })],
    { env, timeout: 120000, maxBuffer: 1024 * 1024 }
  )
  const evidence = JSON.parse(stdout)
  assert.equal(evidence.completeContentPublishedWhileOccupied, true)
  assert.equal(evidence.migrationJournalReplacedAfterHandleClosed, true)
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
