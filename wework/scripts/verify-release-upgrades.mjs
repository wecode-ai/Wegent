import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extract } from 'tar'
import { hashReleaseAsset } from './lib/portable-desktop-release.mjs'
import { mergeUpgradePolicy, upgradeSource, verifiedUpgradeEdge } from './lib/upgrade-evidence.mjs'
import { validateUpgradeCatalog } from '../electron/src/runtime/upgrade-policy.mjs'
import { UPGRADE_SUITE_VERSION } from '../e2e/desktop/upgrade-suite.mjs'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [assetsDirectory, platform, arch, channel, repository, releaseTag] = process.argv.slice(2)
if (!assetsDirectory || !platform || !arch || !channel || !repository || !releaseTag)
  throw new Error('Expected assets, platform, architecture, channel, repository, and release tag')
if (!['macos', 'windows'].includes(platform))
  throw new Error('Upgrade verification requires macOS or Windows')
const assets = resolve(assetsDirectory)
const policy = JSON.parse(await readFile(join(root, 'upgrade-policy.json'), 'utf8'))
if (policy.schemaVersion !== 1 || !Array.isArray(policy.sourceVersions))
  throw new Error('Invalid authored upgrade policy')
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
  const channels = channel === 'stable' ? ['stable', 'beta'] : ['beta']
  const catalogs = {}
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
  for (const existingChannel of ['stable', 'beta']) {
    const previousFile = join(temporary, `components-${existingChannel}.json`)
    // A missing initial channel is allowed only for a baseline with no incoming edges.
    // Network, permission and malformed-manifest errors remain release failures.
    const assetName = `components-${existingChannel}-${platform}-${arch}.json`
    if (shared.assets.some(asset => asset.name === assetName)) {
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
      if (existing) {
        const catalog = validateUpgradeCatalog(existing)
        if (
          catalog.channel !== existingChannel ||
          catalog.platform !== platform ||
          catalog.arch !== arch
        )
          throw new Error('Published upgrade policy target mismatch')
        catalogs[existingChannel] = catalog
      }
    }
  }
  const published = Object.values(catalogs)
  if (
    published.some(catalog => catalog.releases.some(item => item.version === release.version)) &&
    upgradeSource(published, release.version).sha256 !== release.sha256
  )
    throw new Error('A published release package is immutable across channels')
  for (const targetChannel of channels) {
    const base = catalogs[targetChannel] ?? null
    const edges = []
    const sources = []
    if (
      published.some(catalog => catalog.releases.some(item => item.version !== release.version)) &&
      policy.sourceVersions.length === 0
    )
      throw new Error(
        'A subsequent release must declare and verify at least one incoming upgrade edge'
      )
    for (const sourceVersion of policy.sourceVersions) {
      const source = upgradeSource([base, ...published], sourceVersion)
      sources.push(source)
      const directory = join(temporary, `${targetChannel}-${sourceVersion}`)
      await mkdir(directory, { recursive: true })
      const name = `WeWorkRelease_${sourceVersion}_${platform}_${arch}.tar.gz`
      const archive = join(directory, name)
      await execute('gh', [
        'release',
        'download',
        `wework-v${sourceVersion}`,
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
        descriptor.version !== sourceVersion ||
        descriptor.fixture ||
        descriptor.sourceSha !== source.sourceSha
      )
        throw new Error('Source release identity is invalid')
      const sourceResources = resolve(sourceRoot, descriptor.resources)
      const pair = {
        schemaVersion: 1,
        kind: 'release',
        suiteVersion: UPGRADE_SUITE_VERSION,
        channel: targetChannel,
        from: {
          ...source,
          path: archive,
          executable: resolve(sourceRoot, descriptor.executable),
          executor: join(
            sourceResources,
            'bin',
            platform === 'windows' ? 'wegent-executor.exe' : 'wegent-executor'
          ),
        },
        to: { ...release, path: join(assets, release.name) },
      }
      const pairPath = join(directory, 'pair.json')
      const evidenceFile = join(directory, 'evidence.json')
      await writeFile(pairPath, JSON.stringify(pair))
      await run(
        process.execPath,
        ['e2e/desktop/run-checkpoints.mjs', '--segment', 'app-rollback'],
        {
          WEWORK_E2E_APP_BIN: pair.from.executable,
          WEWORK_E2E_EXECUTOR_BIN: pair.from.executor,
          WEWORK_E2E_UPGRADE_PAIR: pairPath,
          WEWORK_E2E_UPGRADE_EVIDENCE: evidenceFile,
          WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1',
        }
      )
      const evidenceBytes = await readFile(evidenceFile)
      edges.push(
        verifiedUpgradeEdge({
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
      )
      await writeFile(
        join(
          assets,
          `upgrade-evidence-${targetChannel}-${sourceVersion}-${release.version}-${platform}-${arch}.json`
        ),
        evidenceBytes
      )
    }
    const verified = mergeUpgradePolicy(
      base,
      node,
      edges,
      {
        channel: targetChannel,
        platform,
        arch,
      },
      sources
    )
    await writeFile(
      join(assets, `upgrade-policy-${targetChannel}-${platform}-${arch}.json`),
      JSON.stringify(verified, null, 2) + '\n'
    )
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function run(command, args, environment) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? accept() : reject(new Error(`Real release upgrade E2E failed: ${code}`))
    )
  })
}
