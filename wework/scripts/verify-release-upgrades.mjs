import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extract } from 'tar'
import { hashReleaseAsset } from './lib/portable-desktop-release.mjs'
import {
  mergeUpgradePolicy,
  releaseUpgradePlan,
  upgradeSource,
  verifiedUpgradeEdge,
  verifyReleaseUpgradePlan,
} from './lib/upgrade-evidence.mjs'
import { validateUpgradeCatalog } from '../electron/src/runtime/upgrade-policy.mjs'
import { UPGRADE_SUITE_VERSION } from '../e2e/desktop/upgrade-suite.mjs'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [assetsDirectory, platform, arch, channel, repository, releaseTag] = process.argv.slice(2)
if (!assetsDirectory || !platform || !arch || !channel || !repository || !releaseTag)
  throw new Error('Expected assets, platform, architecture, channel, repository, and release tag')
if (!['macos', 'windows'].includes(platform))
  throw new Error('Upgrade verification requires macOS or Windows')
if (!['stable', 'beta'].includes(channel)) throw new Error('Invalid release channel')
const assets = resolve(assetsDirectory)
const diagnostics = resolve(
  process.env.WEWORK_UPGRADE_DIAGNOSTICS_DIR || join(root, 'test-results', 'release-upgrades')
)
const policy = JSON.parse(await readFile(join(root, 'upgrade-policy.json'), 'utf8'))
if (policy.schemaVersion !== 1) throw new Error('Invalid authored upgrade policy')
const release = JSON.parse(await readFile(join(assets, `release-${platform}-${arch}.json`), 'utf8'))
if (release.fixture || release.version !== releaseTag.replace(/^wework-v/, ''))
  throw new Error('Release verification cannot promote a regression fixture')
const node = {
  ...release,
  path: undefined,
  url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(release.name)}`,
  minSourceVersion: policy.minSourceVersion,
  revoked: false,
}
const temporary = await mkdtemp(join(tmpdir(), 'wework-release-upgrades-'))
try {
  const catalogs = await publishedCatalogs()
  const published = Object.values(catalogs)
  if (
    published.some(catalog => catalog.releases.some(item => item.version === release.version)) &&
    upgradeSource(published, release.version).sha256 !== release.sha256
  )
    throw new Error('A published release package is immutable across channels')
  for (const targetChannel of channel === 'stable' ? ['stable', 'beta'] : ['beta'])
    await verifyChannel(catalogs, targetChannel)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function publishedCatalogs() {
  const shared = JSON.parse(
    (
      await execute('gh', [
        'release',
        'view',
        'wework-updater',
        '--repo',
        repository,
        '--json',
        'assets',
      ])
    ).stdout
  )
  const catalogs = {}
  for (const existingChannel of ['stable', 'beta']) {
    const assetName = `components-${existingChannel}-${platform}-${arch}.json`
    // Only a genuinely missing initial catalog permits a baseline without incoming edges.
    if (!shared.assets.some(asset => asset.name === assetName)) continue
    const previousFile = join(temporary, assetName)
    await execute('gh', [
      'release',
      'download',
      'wework-updater',
      '--repo',
      repository,
      '--pattern',
      assetName,
      '--output',
      previousFile,
    ])
    const existing = JSON.parse(await readFile(previousFile, 'utf8')).upgradePolicy
    if (!existing) continue
    const catalog = validateUpgradeCatalog(existing)
    if (
      catalog.channel !== existingChannel ||
      catalog.platform !== platform ||
      catalog.arch !== arch
    )
      throw new Error('Published upgrade policy target mismatch')
    catalogs[existingChannel] = catalog
  }
  return catalogs
}

async function verifyChannel(catalogs, targetChannel) {
  const plan = releaseUpgradePlan(Object.values(catalogs), node, targetChannel)
  const report = {
    schemaVersion: 1,
    version: release.version,
    platform,
    arch,
    channel: targetChannel,
    baselineVersion: plan?.baselineVersion ?? release.version,
    previousVersion: plan?.previous.version ?? null,
    status: 'running',
    attempts: [],
  }
  if (plan && !plan.baseline)
    report.attempts.push({ version: plan.baselineVersion, status: 'unavailable' })
  const reportDirectory = join(diagnostics, targetChannel)
  await mkdir(reportDirectory, { recursive: true })
  const saveReport = async () => {
    try {
      await writeFile(join(reportDirectory, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      console.warn(`Cannot save upgrade verification diagnostics: ${error.code ?? error.name}`)
    }
  }
  await saveReport()
  try {
    const result = await verifyReleaseUpgradePlan(plan, async source => {
      const edge = await verifySource(source, targetChannel)
      report.attempts.push({
        version: source.version,
        sha256: source.sha256,
        status: edge ? 'passed' : 'failed',
      })
      await saveReport()
      return edge
    })
    const minSourceVersion = result?.minSourceVersion ?? release.version
    const verified = mergeUpgradePolicy(
      catalogs[targetChannel] ?? null,
      { ...node, minSourceVersion },
      result?.verified.map(item => item.result) ?? [],
      { channel: targetChannel, platform, arch },
      result?.verified.map(item => item.source) ?? []
    )
    await writeFile(
      join(assets, `upgrade-policy-${targetChannel}-${platform}-${arch}.json`),
      JSON.stringify(verified, null, 2) + '\n'
    )
    report.status = 'passed'
    report.minSourceVersion = minSourceVersion
    console.log(
      `Verified ${targetChannel}/${platform}/${arch} ${release.version}: minimum source ${minSourceVersion}`
    )
  } catch (error) {
    report.status = 'blocked'
    throw error
  } finally {
    await saveReport()
  }
}

async function downloadSource(source, targetChannel) {
  const directory = join(temporary, `${targetChannel}-${source.version}`)
  await mkdir(directory, { recursive: true })
  const name = `WeWorkRelease_${source.version}_${platform}_${arch}.tar.gz`
  const archive = join(directory, name)
  await execute('gh', [
    'release',
    'download',
    `wework-v${source.version}`,
    '--repo',
    repository,
    '--pattern',
    name,
    '--output',
    archive,
  ])
  if ((await hashReleaseAsset(archive)) !== source.sha256)
    throw new Error('The historical source package changed')
  const sourceRoot = join(directory, 'source')
  await mkdir(sourceRoot)
  await extract({ file: archive, cwd: sourceRoot, strict: true })
  const descriptor = JSON.parse(await readFile(join(sourceRoot, 'wework-release.json'), 'utf8'))
  if (
    descriptor.version !== source.version ||
    descriptor.fixture ||
    descriptor.sourceSha !== source.sourceSha
  )
    throw new Error('Source release identity is invalid')
  return {
    ...source,
    path: archive,
    executable: resolve(sourceRoot, descriptor.executable),
    executor: join(
      sourceRoot,
      descriptor.resources,
      'bin',
      platform === 'windows' ? 'wegent-executor.exe' : 'wegent-executor'
    ),
  }
}

async function verifySource(source, targetChannel) {
  console.log(
    `Verifying ${source.version} -> ${release.version} (${targetChannel}/${platform}/${arch})`
  )
  const from = await downloadSource(source, targetChannel)
  const directory = dirname(from.path)
  const pairPath = join(directory, 'pair.json')
  const evidenceFile = join(directory, 'evidence.json')
  await writeFile(
    pairPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: 'release',
      suiteVersion: UPGRADE_SUITE_VERSION,
      channel: targetChannel,
      from,
      to: { ...release, path: join(assets, release.name) },
    })
  )
  const passed = await run({
    WEWORK_E2E_APP_BIN: from.executable,
    WEWORK_E2E_EXECUTOR_BIN: from.executor,
    WEWORK_E2E_UPGRADE_PAIR: pairPath,
    WEWORK_E2E_UPGRADE_EVIDENCE: evidenceFile,
    WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1',
    WEWORK_E2E_RESULT_ROOT: join(diagnostics, targetChannel, source.version),
  })
  if (!passed) return null
  const evidenceBytes = await readFile(evidenceFile)
  const edge = verifiedUpgradeEdge({
    from: source,
    to: node,
    evidence: JSON.parse(evidenceBytes),
    evidenceBytes,
    runId: process.env.GITHUB_RUN_ID,
    suiteVersion: UPGRADE_SUITE_VERSION,
    platform,
    arch,
    channel: targetChannel,
  })
  await writeFile(
    join(
      assets,
      `upgrade-evidence-${targetChannel}-${source.version}-${release.version}-${platform}-${arch}.json`
    ),
    evidenceBytes
  )
  return edge
}

async function run(environment) {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      ['e2e/desktop/run-checkpoints.mjs', '--segment', 'app-rollback'],
      {
        cwd: root,
        env: { ...process.env, ...environment },
        stdio: 'inherit',
      }
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Upgrade verification interrupted by ${signal}`))
      else accept(code === 0)
    })
  })
}
