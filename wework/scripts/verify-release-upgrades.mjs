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
  releaseVerificationChannels,
  releaseUpgradePlan,
  upgradeSource,
  verifiedUpgradeEdge,
} from './lib/upgrade-evidence.mjs'
import { publishedUpgradePolicies } from './lib/published-upgrade-policies.mjs'
import {
  bundledRuntimeCacheKey,
  prepareBundledRuntimeCache,
} from '../e2e/desktop/modules/bundled-runtime-cache.mjs'
import { validateUpgradeShardPlan } from './lib/upgrade-verification-shards.mjs'
import { withTemporaryBuildDirectory } from './lib/temporary-build-directory.mjs'
import { preparePackagedRuntimeCache } from './lib/packaged-runtime-preparation.mjs'
import { prepareInstalledSourceSnapshot } from './lib/installed-source-snapshot-preparation.mjs'
import { waitForUpgradeSourcePrefetch } from './lib/upgrade-source-prefetch.mjs'
import { usesLegacyReleaseLayout } from '../electron/src/runtime/legacy-release-layout.mjs'
import {
  upgradeVerificationCheckpoint,
  upgradeIncludesFaultRecovery,
  UPGRADE_DIAGNOSTIC_CHECKPOINTS,
  UPGRADE_SOURCE_DIAGNOSTICS,
  UPGRADE_SUITE_VERSION,
  rejectFailedReleaseCheckpoint,
} from '../e2e/desktop/upgrade-suite.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [assetsDirectory, platform, arch, channel, repository, releaseTag] = process.argv.slice(2)
if (!assetsDirectory || !platform || !arch || !channel || !repository || !releaseTag)
  throw new Error('Expected assets, platform, architecture, channel, repository, and release tag')
if (!['macos', 'windows'].includes(platform))
  throw new Error('Upgrade verification requires macOS or Windows')
const verificationStarted = performance.now()
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
  (sourceAssets && !UPGRADE_SOURCE_DIAGNOSTICS.includes(diagnosticCheckpoint)) ||
  (UPGRADE_SOURCE_DIAGNOSTICS.includes(diagnosticCheckpoint) && !sourceAssets)
)
  throw new Error('The update diagnostic requires immutable source artifacts and their version')
const releaseChannels = releaseVerificationChannels(
  channel,
  process.env.WEWORK_UPGRADE_VERIFY_CHANNEL || '',
  sourceVersion
)
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
const planDirectory = process.env.WEWORK_UPGRADE_PLAN_DIRECTORY || ''
const shardSourceVersion = process.env.WEWORK_UPGRADE_VERIFY_SOURCE || ''
if (
  Boolean(planDirectory) !== Boolean(shardSourceVersion) ||
  (planDirectory && diagnosticCheckpoint)
)
  throw new Error('Source sharding requires a frozen complete verification plan')
if (!diagnosticCheckpoint && !planDirectory)
  throw new Error('Complete verification requires the frozen source matrix')
const frozen = planDirectory
  ? validateUpgradeShardPlan(
      JSON.parse(await readFile(join(planDirectory, `${platform}-${arch}.json`), 'utf8')),
      { version: node.version, channel, policy, platform, arch }
    )
  : null
const prefetchDirectory = process.env.WEWORK_UPGRADE_PREFETCH_DIRECTORY || ''
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'wework-release-upgrades-')))
try {
  if (prefetchDirectory) await waitForUpgradeSourcePrefetch(prefetchDirectory)
  const catalogs = frozen?.catalogs ?? publishedUpgradePolicies({ repository, platform, arch })
  const published = Object.values(catalogs)
  if (
    published.some(catalog => catalog.releases.some(item => item.version === release.version)) &&
    upgradeSource(published, release.version).sha256 !== release.sha256
  )
    throw new Error('A published release package is immutable across channels')
  for (const targetChannel of releaseChannels) await verifyChannel(catalogs, targetChannel)
} finally {
  await rm(temporary, { recursive: true, force: true })
  if (prefetchDirectory) await rm(prefetchDirectory, { recursive: true, force: true })
  console.log(
    `[upgrade-verification] ${JSON.stringify({
      event: 'finished',
      platform,
      arch,
      channels: releaseChannels,
      elapsedMs: Math.round(performance.now() - verificationStarted),
    })}`
  )
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
    if (frozen) {
      const selected = frozen.channels.find(item => item.channel === targetChannel)
      const source = selected.sources.find(item => item.version === shardSourceVersion) ?? null
      if (!source && !(shardSourceVersion === 'initial' && selected.sources.length === 0))
        throw new Error('The source shard is outside the frozen verification plan')
      const edge = source ? await verifySource(source, targetChannel, plan?.previous) : null
      report.status = source ? (edge ? 'passed' : 'failed') : 'initial'
      if (source)
        report.attempts.push({
          version: source.version,
          sha256: source.sha256,
          status: report.status,
        })
      const evidence = edge
        ? await readFile(
            join(
              assets,
              `upgrade-evidence-${targetChannel}-${source.version}-${release.version}-${platform}-${arch}.json`
            ),
            'utf8'
          )
        : null
      await writeFile(
        join(
          assets,
          `upgrade-shard-${targetChannel}-${shardSourceVersion}-${platform}-${arch}.json`
        ),
        JSON.stringify({
          schemaVersion: 1,
          suiteVersion: UPGRADE_SUITE_VERSION,
          runId: String(process.env.GITHUB_RUN_ID),
          channel: targetChannel,
          source,
          target: node,
          status: report.status,
          evidence,
        }) + '\n'
      )
      return
    }
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
  } catch (error) {
    report.status = diagnosticCheckpoint ? 'diagnostic-failed' : 'blocked'
    throw error
  } finally {
    await saveReport()
  }
}

async function downloadSource(source, targetChannel) {
  const downloaded = sourceAssets
    ? await readPrebuiltDesktopRelease({
        directory: resolve(sourceAssets),
        version: source.version,
        platform,
        arch,
        installation: join(temporary, `${targetChannel}-${source.version}`, 'source'),
      })
    : await downloadPublishedDesktopRelease({
        repository,
        version: source.version,
        platform,
        arch,
        directory: prefetchDirectory
          ? join(prefetchDirectory, source.version)
          : join(temporary, `${targetChannel}-${source.version}`),
        expected: source,
      })
  return {
    ...downloaded,
    preparationCache: join(temporary, 'installed-source-snapshots', downloaded.sha256),
    runtimeCache: join(
      temporary,
      'installed-runtimes',
      await bundledRuntimeCacheKey(downloaded.resources)
    ),
  }
}

async function downloadSourceInputs(source, targetChannel, previous) {
  const from = await downloadSource(source, targetChannel)
  // Only the broken legacy selector can leave a newer, unstarted activation
  // while continuing to run A. Modern selectors correctly start that package.
  if (
    upgradeIncludesFaultRecovery(platform) &&
    previous &&
    source.version !== previous.version &&
    usesLegacyReleaseLayout(source.version)
  )
    from.installedSource = await downloadSource(previous, targetChannel)
  return from
}

async function prepareSourcePrograms(from, target, targetPrograms) {
  const targetKey = await bundledRuntimeCacheKey(target.resources)
  const preparations = []
  let sourceError
  try {
    for (const installed of [from, from.installedSource].filter(Boolean)) {
      const matches = (await bundledRuntimeCacheKey(installed.resources)) === targetKey
      const reuseRoot = matches && targetPrograms ? await targetPrograms : undefined
      await prepareBundledRuntimeCache(installed.resources, installed.runtimeCache, { reuseRoot })
      if (installed === from)
        preparations.push(
          Promise.allSettled([
            prepareInstalledSourceSnapshot(from, {
              diagnosticsDirectory: join(diagnostics, 'preparation', from.version),
            }),
          ])
        )
    }
  } catch (error) {
    sourceError = error
  }
  const results = (await Promise.all(preparations)).flat()
  const errors = [
    sourceError,
    ...results.filter(result => result.status === 'rejected').map(result => result.reason),
  ].filter(Boolean)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Source input preparation failed')
}

async function verifySource(source, targetChannel, previous) {
  console.log(
    `Verifying ${source.version} -> ${release.version} (${targetChannel}/${platform}/${arch})`
  )
  const immutableRuntimeCache = join(temporary, 'prepared-runtimes', release.sha256)
  const from = await withTemporaryBuildDirectory({
    prefix: 'wework-upgrade-inputs-',
    builds: [
      directory =>
        readPrebuiltDesktopRelease({
          directory: assets,
          version: release.version,
          platform,
          arch,
          installation: join(directory, 'target'),
        }),
      () => downloadSourceInputs(source, targetChannel, previous),
    ],
    consume: async ([target, prepared], directory) => {
      // Matching installed source programs already satisfy the target's reuse
      // contract. Its real UI preparation still verifies its delivered archive.
      const matchesSource =
        (await bundledRuntimeCacheKey(prepared.resources)) ===
        (await bundledRuntimeCacheKey(target.resources))
      const targetPrograms = matchesSource
        ? null
        : preparePackagedRuntimeCache({
            target,
            directory,
            immutableRoot: immutableRuntimeCache,
          })
      const results = await Promise.allSettled([
        targetPrograms,
        prepareSourcePrograms(prepared, target, targetPrograms),
      ])
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      return prepared
    },
  })
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
      immutableRuntimeCache,
      from,
      to: { ...release, path: join(assets, release.name) },
    })
  )
  await run({
    WEWORK_E2E_APP_BIN: from.executable,
    WEWORK_E2E_EXECUTOR_BIN: from.executor,
    WEWORK_E2E_UPGRADE_PAIR: pairPath,
    WEWORK_E2E_UPGRADE_EVIDENCE: diagnosticCheckpoint ? '' : evidenceFile,
    WEWORK_E2E_UPGRADE_EVIDENCE_CHECKPOINT: 'app-rollback',
    WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1',
    WEWORK_E2E_RESULT_ROOT: join(diagnostics, targetChannel, source.version),
  })
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
        diagnosticCheckpoint || upgradeVerificationCheckpoint(platform),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...environment,
          // Default-layout migration and Windows singleton identity both use
          // the OS-wide legacy application-data name, despite isolated HOME.
          WEWORK_E2E_PARALLEL_CHECKPOINTS: '1',
          WEWORK_E2E_PARALLEL_SCOPE: 'core',
        },
        stdio: 'inherit',
      }
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Upgrade verification interrupted by ${signal}`))
      else {
        try {
          rejectFailedReleaseCheckpoint(
            diagnosticCheckpoint || upgradeVerificationCheckpoint(platform),
            { code }
          )
          accept(true)
        } catch (error) {
          reject(error)
        }
      }
    })
  })
}
