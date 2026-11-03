import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { resolveUpgradeInputs } from '../../.github/scripts/resolve-wework-upgrade-inputs.mjs'
import { readDesktopReleaseInstallation } from './lib/published-desktop-release.mjs'
import { upgradeUserEnvironment } from '../e2e/desktop/modules/upgrade-user-environment.mjs'

const execute = promisify(execFile)
const require = createRequire(new URL('../electron/package.json', import.meta.url))
const tar = require('tar')
const asset =
  'harness-runtime-windows-x64-dsh-0.2.0-rc.2-e67e5ad2e167baf839e1335ba88432b225bad15a3ecbe5fdd3c7ab5b269c6297'
const profileBase = process.env.WEWORK_RUNTIME_PROFILE_RUN_ID ? process.env.APPDATA : tmpdir()
assert.ok(profileBase && isAbsolute(profileBase), 'The Windows application-data volume is required')
const directory = await mkdtemp(join(profileBase, 'wework-runtime-profile-'))

async function measure(phase, operation) {
  const started = performance.now()
  const result = await operation()
  console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }))
  return result
}

async function deliveredHostRuntime() {
  const inputs = resolveUpgradeInputs({
    ...process.env,
    SOURCE_RUN_ID: process.env.WEWORK_RUNTIME_PROFILE_RUN_ID,
    VERIFICATION_SHA: process.env.GITHUB_SHA,
    REPLAY: 'true',
    PUBLISH_RELEASE: 'false',
    VERIFICATION_CHECKPOINT: 'all',
  })
  const destination = join(directory, 'candidate')
  await measure('host-download', () =>
    execute('gh', [
      'run',
      'download',
      inputs.run_id,
      '--repo',
      process.env.GITHUB_REPOSITORY,
      '--name',
      `wework-upgrade-input-${inputs.version}-windows-x64`,
      '--dir',
      destination,
    ])
  )
  const assets = join(destination, 'wework-release-assets')
  const release = JSON.parse(await readFile(join(assets, 'release-windows-x64.json'), 'utf8'))
  assert.equal(release.version, inputs.version)
  assert.equal(release.fixture, false)
  assert.equal(release.name, `WeWorkRelease_${inputs.version}_windows_x64.tar.gz`)
  const archive = join(assets, release.name)
  await measure('host-integrity', () =>
    assertArchive(archive, { archiveBytes: release.bytes, archiveSha256: release.sha256 })
  )
  const groups = new Map()
  await measure('host-inflate-and-parse', () =>
    tar.list({
      file: archive,
      strict: true,
      onentry(entry) {
        const parts = entry.path.split('/')
        const prefix = parts.slice(0, parts[1] === 'resources' ? 3 : 2).join('/')
        const current = groups.get(prefix) || { entries: 0, bytes: 0 }
        current.entries++
        current.bytes += entry.size || 0
        groups.set(prefix, current)
      },
    })
  )
  console.log(
    JSON.stringify({
      hostEntries: [...groups.entries()].sort((left, right) => right[1].entries - left[1].entries),
    })
  )
  const host = join(directory, 'host')
  await mkdir(host)
  await measure('host-node-tar-extraction', () =>
    tar.extract({ file: archive, cwd: host, strict: true })
  )
  const installation = await readDesktopReleaseInstallation(host, release)
  const literal = installation.executable.replaceAll("'", "''")
  for (const [name, environment] of [
    ['native', process.env],
    ['isolated', upgradeUserEnvironment(process.env, directory)],
  ])
    await measure(`powershell-startup-${name}`, () =>
      execute(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Write("ready")'],
        {
          env: environment,
          windowsHide: true,
          timeout: 120_000,
        }
      )
    )
  for (const phase of ['signature-cold', 'signature-warm']) {
    const { stdout } = await measure(phase, () =>
      execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status.ToString()`,
        ],
        {
          windowsHide: true,
          timeout: 120_000,
          env: upgradeUserEnvironment(process.env, directory),
        }
      )
    )
    const status = stdout.replace(/^\uFEFF/, '').trim()
    assert.ok(['Valid', 'NotSigned'].includes(status), `Unexpected signature status: ${status}`)
    console.log(JSON.stringify({ phase, status }))
  }
  // A pwsh runner exports its own module search path to Windows PowerShell.
  // Load the requested system module explicitly instead of importing a module
  // from another PowerShell edition into this diagnostic process.
  const systemSignature = await measure('signature-explicit-system-module', () =>
    execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; (Get-AuthenticodeSignature -LiteralPath '${literal}').Status.ToString()`,
      ],
      {
        env: upgradeUserEnvironment(process.env, directory),
        windowsHide: true,
        timeout: 120_000,
      }
    )
  )
  assert.ok(['Valid', 'NotSigned'].includes(systemSignature.stdout.replace(/^\uFEFF/, '').trim()))
  const resources = join(installation.resources, 'harness-runtime')
  const catalog = JSON.parse(await readFile(join(resources, 'runtimes.json'), 'utf8'))
  const runtime = catalog.runtimes.find(item => item.role === 'core')
  assert.ok(runtime && !/[\\/]/.test(runtime.assetName))
  return { descriptor: runtime, archive: join(resources, runtime.assetName) }
}

async function assertArchive(archive, descriptor) {
  assert.equal((await stat(archive)).size, descriptor.archiveBytes)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  assert.equal(hash.digest('hex'), descriptor.archiveSha256)
}

try {
  assert.equal(process.platform, 'win32', 'This diagnostic requires a real Windows runner')
  console.log(
    JSON.stringify({ profileVolume: parse(directory).root, temporaryVolume: parse(tmpdir()).root })
  )
  let candidate
  if (process.env.WEWORK_RUNTIME_PROFILE_RUN_ID) candidate = await deliveredHostRuntime()
  else
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
  const archive = candidate?.archive || join(directory, `${asset}.tar.gz`)
  const descriptor =
    candidate?.descriptor || JSON.parse(await readFile(join(directory, `${asset}.json`), 'utf8'))
  await measure('sha256', () => assertArchive(archive, descriptor))
  await measure('inflate-and-parse', () => tar.list({ file: archive, strict: true }))
  const modes = process.argv.includes('--compare') ? ['native', 'sync', 'async'] : ['native']
  for (const mode of modes) {
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
