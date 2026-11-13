import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { unavailableUpdatePolicy } from './app-update-retry.mjs'
import { createIntervalUpgradeProbe } from './interval-upgrade-policy.mjs'

/** Serve immutable package bytes through the real update protocol. */
export async function createUpgradeUpdateServer({ pair, channel, currentOffer }) {
  let origin
  const unavailablePolicy = () => ({
    ...unavailableUpdatePolicy(
      { ...pair.from, appVersion: pair.from.version },
      { platform: pair.to.platform, arch: pair.to.arch },
      origin
    ),
    channel,
  })
  const requests = []
  const intervalProbe = createIntervalUpgradeProbe(pair, () => origin, requests)
  // Observe asynchronous acceptance before releasing real package bytes. A fixed
  // six-second server delay charged every checkpoint without establishing state.
  let releaseHostDownload
  const hostDownloadAccepted = new Promise(accept => {
    releaseHostDownload = accept
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin)
    const offer = currentOffer()
    requests.push({
      path: url.pathname,
      method: request.method,
      range: request.headers.range ?? null,
    })
    if (url.pathname.startsWith('/components-')) {
      if (intervalProbe.handleManifest(response)) return
      if (offer === 'refresh-failed') {
        response.writeHead(503)
        response.end()
        return
      }
      if (offer !== 'target') {
        const policy = unavailablePolicy()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            upgradePolicy:
              offer === 'withdrawn'
                ? { ...policy, releases: policy.releases.slice(0, 1), edges: [] }
                : policy,
          })
        )
        return
      }
      const releases = [pair.from, pair.to].map(asset => ({
        ...asset,
        url: `${origin}/${asset.name}`,
        minSourceVersion: pair.from.version === asset.version ? '0.0.0' : pair.from.version,
        revoked: false,
      }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          upgradePolicy: {
            schemaVersion: 1,
            channel,
            platform: pair.to.platform,
            arch: pair.to.arch,
            releases,
            edges: [
              {
                from: pair.from.version,
                to: pair.to.version,
                fromSha256: pair.from.sha256,
                toSha256: pair.to.sha256,
                fromSourceSha: pair.from.sourceSha,
                toSourceSha: pair.to.sourceSha,
                runId: String(process.env.GITHUB_RUN_ID || 1),
                evidenceSha256: 'a'.repeat(64),
                upgrade: 'passed',
                rollback: 'passed',
                revoked: false,
              },
            ],
          },
        })
      )
    } else if (url.pathname === '/unavailable-release.tar.gz') {
      response.writeHead(503)
      response.end()
    } else if (url.pathname === `/${pair.to.name}`) {
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': pair.to.bytes,
      })
      if (request.headers.range) {
        response.destroy(new Error('Whole release downloads must not use byte ranges'))
        return
      }
      void hostDownloadAccepted.then(() => {
        if (!response.destroyed) createReadStream(pair.to.path).pipe(response)
      })
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, requests, releaseHostDownload, unavailablePolicy, intervalProbe }
}
