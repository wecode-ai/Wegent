import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'

/** Discovery-only fixture: its future target must never become release evidence. */
export function intervalUpgradeCatalog(pair, origin) {
  const [major, minor, patch] = pair.to.version.split('-')[0].split('.').map(Number)
  const release = asset => ({
    ...asset,
    minSourceVersion: pair.from.version,
    url: `${origin}/${asset.name}`,
    revoked: false,
  })
  const target = {
    ...release(pair.to),
    version: `${major}.${minor}.${patch + 1}`,
    url: `${origin}/interval-policy-fixture-no-archive.tar.gz`,
    sha256: 'd'.repeat(64),
    sourceSha: 'd'.repeat(40),
    fixture: true,
  }
  return {
    schemaVersion: 1,
    channel: pair.channel || (pair.to.version.includes('-beta.') ? 'beta' : 'stable'),
    platform: pair.to.platform,
    arch: pair.to.arch,
    releases: [release(pair.from), release(pair.to), target],
    edges: [
      {
        from: pair.from.version,
        to: target.version,
        fromSha256: pair.from.sha256,
        toSha256: target.sha256,
        fromSourceSha: pair.from.sourceSha,
        toSourceSha: target.sourceSha,
        runId: '1',
        evidenceSha256: 'a'.repeat(64),
        upgrade: 'passed',
        rollback: 'passed',
        revoked: false,
      },
    ],
  }
}

/** Reuse the upgraded real host and manifest server, without another package transfer. */
export function createIntervalUpgradeProbe(pair, origin, requests) {
  let policy = null
  return {
    handleManifest(response) {
      if (!policy) return false
      console.log('[upgrade-e2e] Serving interval discovery fixture', {
        from: policy.edges[0].from,
        to: policy.edges[0].to,
        revoked: policy.edges[0].revoked,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ schemaVersion: 1, upgradePolicy: policy }))
      return true
    },
    async verify(control, resultDir) {
      policy = intervalUpgradeCatalog(pair, origin())
      const target = policy.releases.at(-1).version
      const button = '[data-testid="about-check-update-button"]'
      const progress = async () => JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      const start = requests.length
      try {
        await control.command('clickWhenEnabled', button)
        await control.command('waitFor', button, { text: target })
        const offered = (await progress()).update
        assert.equal(offered.currentVersion, pair.to.version)
        assert.equal(offered.version, target)
        assert.equal(offered.targetVersion, target)
        assert.deepEqual(offered.path, [target])
        assert.ok(
          requests.slice(start).some(request => request.path.startsWith('/components-')),
          'The upgraded host must read the isolated interval manifest'
        )

        policy.edges[0].revoked = true
        await control.command('clickWhenEnabled', button)
        await assert.rejects(waitForUpdatePreparation(progress), /No verified upgrade path/)
        const revoked = (await progress()).failure
        assert.equal(revoked.code, 'UPGRADE_PATH_UNAVAILABLE')

        policy = null
        await control.command('clickWhenEnabled', button)
        await control.command('waitFor', '[data-testid="about-update-status"]', {
          text: '已是最新版本',
        })
        assert.equal((await progress()).update, null)
        assert.ok(
          requests.slice(start).every(request => request.path.startsWith('/components-')),
          'Interval discovery and revocation must not download a fixture archive'
        )
        await writeFile(
          join(resultDir, 'interval-policy-result.json'),
          JSON.stringify({ fixtureOnly: true, offered, revoked, recovered: true }, null, 2)
        )
        console.log(
          '[upgrade-e2e] Real target verified interval discovery, revocation and recovery'
        )
      } finally {
        policy = null
      }
    },
  }
}
