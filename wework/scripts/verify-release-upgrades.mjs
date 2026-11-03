import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  downloadPublishedDesktopArchive,
  downloadPublishedDesktopRelease,
  readPrebuiltDesktopRelease,
} from './lib/published-desktop-release.mjs'
import {
  mergeUpgradePolicy,
  releaseUpgradeChannels,
  releaseUpgradePlan,
  upgradeSource,
  verifiedUpgradeEdge,
  verifyReleaseUpgradePlan,
} from './lib/upgrade-evidence.mjs'
import { publishedUpgradePolicies } from './lib/published-upgrade-policies.mjs'
import {
  UPGRADE_CHECKPOINT_GROUP,
  UPGRADE_DIAGNOSTIC_CHECKPOINTS,
  UPGRADE_SUITE_VERSION,
} from '../e2e/desktop/upgrade-suite.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [assetsDirectory, platform, arch, channel, repository, releaseTag] = process.argv.slice(2)
if (!assetsDirectory || !platform || !arch || !channel || !repository || !releaseTag)
  throw new Error('Expected assets, platform, architecture, channel, repository, and release tag')
if (!['macos', 'windows'].includes(platform))
  throw new Error('Upgrade verification requires macOS or Windows')
if (!['stable', 'beta'].includes(channel)) throw new Error('Invalid release channel')
const publishedTarget = process.env.WEWORK_UPGRADE_PUBLISHED_TARGET_TAG || ''
if (publishedTarget && publishedTarget !== releaseTag)
  throw new Error('The published target must match the selected release tag')
const assets = publishedTarget
  ? join(resolve(assetsDirectory), 'published-target')
  : resolve(assetsDirectory)
if (publishedTarget)
  await downloadPublishedDesktopArchive({
    repository,
    version: publishedTarget.replace(/^wework-v/, ''),
    platform,
    arch,
    directory: assets,
  })
const diagnosticCheckpoint = process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT || ''
if (diagnosticCheckpoint && !UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(diagnosticCheckpoint))
  throw new Error('Invalid upgrade diagnostic checkpoint')
const sourceAssets = process.env.WEWORK_UPGRADE_SOURCE_ASSETS || ''
const sourceVersion = process.env.WEWORK_UPGRADE_SOURCE_VERSION || ''
if (
  Boolean(sourceAssets) !== Boolean(sourceVersion) ||
  (sourceAssets && diagnosticCheckpoint !== 'app-update-refresh') ||
  (diagnosticCheckpoint === 'app-update-refresh' && !sourceAssets)
)
  throw new Error('The refresh diagnostic requires immutable source artifacts and their version')
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
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'wework-release-upgrades-')))
try {
  const catalogs = publishedUpgradePolicies({ repository, platform, arch })
  const published = Object.values(catalogs)
  if (
    published.some(catalog => catalog.releases.some(item => item.version === release.version)) &&
    upgradeSource(published, release.version).sha256 !== release.sha256
  )
    throw new Error('A published release package is immutable across channels')
  for (const targetChannel of releaseUpgradeChannels(channel, sourceVersion))
    await verifyChannel(catalogs, targetChannel)
} finally {
  await rm(temporary, { recursive: true, force: true })
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
    if (diagnosticCheckpoint) {
      if (!sourceAssets && !plan?.previous)
        throw new Error('Diagnostic replay requires a previous release')
      report.checkpoint = diagnosticCheckpoint
      const source = sourceAssets ? { version: sourceVersion } : plan.previous
      report.previousVersion = source.version
      const passed = await verifySource(source, targetChannel)
      report.attempts.push({ version: source.version, status: passed ? 'passed' : 'failed' })
      report.status = passed ? 'diagnostic-passed' : 'diagnostic-failed'
      if (!passed) throw new Error('Upgrade diagnostic checkpoint failed')
      return
    }
    const requiredSources = (policy.requiredDirectUpgrades?.[release.version] ?? []).map(version =>
      upgradeSource(
        targetChannel === 'stable' ? [catalogs.stable] : Object.values(catalogs),
        version
      )
    )
    const result = await verifyReleaseUpgradePlan(
      plan,
      async source => {
        const edge = await verifySource(source, targetChannel, plan?.previous)
        report.attempts.push({
          version: source.version,
          sha256: source.sha256,
          status: edge ? 'passed' : 'failed',
        })
        await saveReport()
        return edge
      },
      requiredSources
    )
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
    report.status = diagnosticCheckpoint ? 'diagnostic-failed' : 'blocked'
    throw error
  } finally {
    await saveReport()
  }
}

async function downloadSource(source, targetChannel) {
  if (sourceAssets)
    return readPrebuiltDesktopRelease({
      directory: resolve(sourceAssets),
      version: source.version,
      platform,
      arch,
      installation: join(temporary, `${targetChannel}-${source.version}`, 'source'),
    })
  return downloadPublishedDesktopRelease({
    repository,
    version: source.version,
    platform,
    arch,
    directory: join(temporary, `${targetChannel}-${source.version}`),
    expected: source,
  })
}

async function verifySource(source, targetChannel, previous) {
  console.log(
    `Verifying ${source.version} -> ${release.version} (${targetChannel}/${platform}/${arch})`
  )
  const from = await downloadSource(source, targetChannel)
  if (previous && source.version !== previous.version)
    from.installedSource = await downloadSource(previous, targetChannel)
  const directory = dirname(from.path)
  const pairPath = join(directory, 'pair.json')
  const evidenceFile = join(directory, 'evidence.json')
  await writeFile(
    pairPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: 'release',
      transport: 'default-update-route',
      applicationId: 'io.wecode.wework',
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
    WEWORK_E2E_UPGRADE_EVIDENCE: diagnosticCheckpoint ? '' : evidenceFile,
    WEWORK_E2E_UPGRADE_EVIDENCE_CHECKPOINT: 'app-rollback',
    WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1',
    WEWORK_E2E_RESULT_ROOT: join(diagnostics, targetChannel, source.version),
  })
  if (!passed) return null
  if (diagnosticCheckpoint) return true
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
      [
        'e2e/desktop/run-checkpoints.mjs',
        '--parallel-segments',
        diagnosticCheckpoint || `${UPGRADE_CHECKPOINT_GROUP},app-update-full`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...environment,
          WEWORK_E2E_PARALLEL_CHECKPOINTS: '1',
          WEWORK_E2E_PARALLEL_SCOPE: 'core',
        },
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
