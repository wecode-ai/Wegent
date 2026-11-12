import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUpgradeUpdateServer } from '../e2e/desktop/modules/upgrade-update-server.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-upgrade-http-'))
  const bytes = Buffer.from('immutable delivered package bytes')
  const pair = {
    from: { version: '0.6.7', name: 'source.tar.gz', sha256: 'a'.repeat(64), sourceSha: 'source' },
    to: {
      version: '0.6.8',
      name: 'target.tar.gz',
      sha256: 'b'.repeat(64),
      sourceSha: 'target',
      platform: 'macos',
      arch: 'arm64',
      path: join(directory, 'target.tar.gz'),
      bytes: bytes.length,
    },
  }
  await writeFile(pair.to.path, bytes)
  let offer = 'target'
  const transport = await createUpgradeUpdateServer({
    pair,
    channel: 'stable',
    currentOffer: () => offer,
  })
  t.after(async () => {
    transport.server.closeAllConnections()
    await new Promise((accept, reject) =>
      transport.server.close(error => (error ? reject(error) : accept()))
    )
    await rm(directory, { recursive: true, force: true })
  })
  return { ...transport, pair, bytes, advertise: value => (offer = value) }
}

test('the update route binds its exact package pair and serves the complete delivered bytes', async t => {
  const transport = await fixture(t)
  const { upgradePolicy } = await (await fetch(`${transport.origin}/components-macos.json`)).json()
  assert.equal(upgradePolicy.channel, 'stable')
  assert.deepEqual(
    upgradePolicy.releases.map(({ version, sha256, sourceSha }) => ({
      version,
      sha256,
      sourceSha,
    })),
    [transport.pair.from, transport.pair.to].map(({ version, sha256, sourceSha }) => ({
      version,
      sha256,
      sourceSha,
    }))
  )
  const edge = upgradePolicy.edges[0]
  assert.equal(edge.fromSha256, transport.pair.from.sha256)
  assert.equal(edge.toSha256, transport.pair.to.sha256)
  assert.equal(edge.fromSourceSha, transport.pair.from.sourceSha)
  assert.equal(edge.toSourceSha, transport.pair.to.sourceSha)
  transport.releaseHostDownload()
  const response = await fetch(`${transport.origin}/${transport.pair.to.name}`)
  assert.equal(response.headers.get('content-length'), String(transport.bytes.length))
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), transport.bytes)
  assert.deepEqual(
    transport.requests.map(({ range }) => range),
    [null, null]
  )
})

test('refresh failure and withdrawal retain their distinct update-policy states', async t => {
  const transport = await fixture(t)
  const manifest = () => fetch(`${transport.origin}/components-macos.json`)
  transport.advertise('refresh-failed')
  assert.equal((await manifest()).status, 503)
  transport.advertise('unavailable')
  const unavailable = (await (await manifest()).json()).upgradePolicy
  assert.equal(unavailable.channel, 'stable')
  assert.equal(unavailable.releases.length, 2)
  assert.equal(unavailable.edges.length, 1)
  assert.equal((await fetch(unavailable.releases[1].url)).status, 503)
  transport.advertise('withdrawn')
  const withdrawn = (await (await manifest()).json()).upgradePolicy
  assert.equal(withdrawn.releases.length, 1)
  assert.deepEqual(withdrawn.edges, [])
  transport.advertise('target')
  const restored = (await (await manifest()).json()).upgradePolicy
  assert.equal(restored.edges[0].toSha256, transport.pair.to.sha256)
})

test('partial package requests cannot produce an accepted archive response', async t => {
  const transport = await fixture(t)
  transport.releaseHostDownload()
  await assert.rejects(
    fetch(`${transport.origin}/${transport.pair.to.name}`, { headers: { range: 'bytes=0-1' } })
  )
  assert.equal(transport.requests[0].range, 'bytes=0-1')
  assert.equal((await fetch(`${transport.origin}/unknown`)).status, 404)
})
