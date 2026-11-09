import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateUpgradeShardPlan } from './upgrade-verification-shards.mjs'
import { downloadPublishedDesktopRelease } from './published-desktop-release.mjs'
import { usesLegacyReleaseLayout } from '../../electron/src/runtime/legacy-release-layout.mjs'
import { upgradeIncludesFaultRecovery } from '../../e2e/desktop/upgrade-suite.mjs'
import { windowsTaskkillArguments } from '../../e2e/desktop/process-lifecycle.mjs'

export function selectedPrefetchSources(frozen, { channel, sourceVersion }) {
  const selected = frozen.channels.find(item => item.channel === channel)
  assert.ok(selected, 'Missing selected channel in frozen upgrade plan')
  const source = selected.sources.find(item => item.version === sourceVersion)
  if (!source) {
    assert.ok(sourceVersion === 'initial' && selected.sources.length === 0)
    return []
  }
  const previous = upgradeIncludesFaultRecovery(frozen.platform) ? selected.plan?.previous : null
  return [
    source,
    previous && previous.version !== source.version && usesLegacyReleaseLayout(source.version)
      ? previous
      : null,
  ].filter(Boolean)
}

export async function prefetchUpgradeSources(options, download = downloadPublishedDesktopRelease) {
  const { directory, planDirectory, platform, arch, version, releaseChannel, repository } = options
  const policy = JSON.parse(
    await readFile(new URL('../../upgrade-policy.json', import.meta.url), 'utf8')
  )
  const frozen = validateUpgradeShardPlan(
    JSON.parse(await readFile(join(planDirectory, `${platform}-${arch}.json`), 'utf8')),
    { version, channel: releaseChannel, policy, platform, arch }
  )
  const sources = selectedPrefetchSources(frozen, options)
  const results = await Promise.allSettled(
    sources.map(source =>
      download({
        repository,
        version: source.version,
        platform,
        arch,
        directory: join(directory, source.version),
        expected: source,
      })
    )
  )
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

// Keep the official target artifact action's digest validation, while historical
// release inputs download independently in this same source runner.
export async function startUpgradeSourcePrefetch(options) {
  await mkdir(options.directory)
  const log = await open(join(options.directory, 'prefetch.log'), 'wx')
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), JSON.stringify(options)],
      {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
      }
    )
    await new Promise((accept, reject) => {
      child.once('spawn', accept)
      child.once('error', reject)
    })
    await writeFile(join(options.directory, 'worker.json'), JSON.stringify({ pid: child.pid }))
    child.unref()
  } finally {
    await log.close()
  }
}

export async function waitForUpgradeSourcePrefetch(directory, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result
    try {
      result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (result) {
      if (!result.success) throw new Error(`Historical input prefetch failed: ${result.error}`)
      return
    }
    await new Promise(accept => setTimeout(accept, 100))
  }
  const worker = JSON.parse(await readFile(join(directory, 'worker.json'), 'utf8'))
  assert.ok(Number.isInteger(worker.pid) && worker.pid > 0)
  if (process.platform === 'win32')
    await promisify(execFile)('taskkill', windowsTaskkillArguments(worker.pid), { timeout: 10_000 })
  else {
    try {
      process.kill(-worker.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  throw new Error('Historical input prefetch did not finish within its preparation budget')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.argv[2])
  let result
  try {
    await prefetchUpgradeSources(options)
    result = { success: true }
  } catch (error) {
    result = { success: false, error: error.message }
  }
  const pending = join(options.directory, 'result.pending.json')
  await writeFile(pending, JSON.stringify(result))
  await rename(pending, join(options.directory, 'result.json'))
  if (!result.success) process.exitCode = 1
}
