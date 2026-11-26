import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { decodeReleaseBlocks } from '../../electron/src/runtime/release-block-map.mjs'
import { upgradeUserEnvironment } from '../../e2e/desktop/modules/upgrade-user-environment.mjs'

const execute = promisify(execFile)

/** Verify the source installer's downloader against immutable producer artifacts. */
export async function verifyPackagedReleaseDelta({ from, target, directory }) {
  if (!from.blockMap || !target.blockMap) return null
  const [sourceIndex, targetIndex] = await Promise.all(
    [from, target].map(asset => readFile(`${asset.path}.blocks`))
  )
  const sourceBlocks = decodeReleaseBlocks(sourceIndex, from.blockMap, from.bytes)
  const targetBlocks = decodeReleaseBlocks(targetIndex, target.blockMap, target.bytes)
  const existing = new Set(sourceBlocks.map(([bytes, hash]) => `${bytes}:${hash}`))
  const missingBytes = targetBlocks.reduce(
    (sum, [bytes, hash]) => sum + (existing.has(`${bytes}:${hash}`) ? 0 : bytes),
    0
  )
  const expectedBytes = sourceIndex.length + targetIndex.length + missingBytes
  const packages = join(directory, 'packages')
  await mkdir(packages, { recursive: true })
  await copyFile(from.path, join(packages, `${from.sha256}.tar.gz`), constants.COPYFILE_FICLONE)
  const script = join(directory, 'verify-package-delta.mjs')
  const module = pathToFileURL(
    join(from.resources, 'app.asar/dist/runtime/release-archive-cache.js')
  )
  await writeFile(
    script,
    `
import assert from 'node:assert/strict'
import { releaseArchive } from ${JSON.stringify(module.href)}
const [directory, origin] = process.argv.slice(2)
const [source, target] = ${JSON.stringify([from, target])}
for (const asset of [source, target]) asset.url = origin + '/' + asset.name
let progress
const result = await releaseArchive(directory, target, fetch, (bytes, total) => {
  progress = { bytes, total }
}, [source])
assert.equal(result.reused, false)
assert.deepEqual(progress, { bytes: ${expectedBytes}, total: ${expectedBytes} })
`
  )
  const transport = await startDeltaServer(from, target, sourceIndex, targetIndex)
  try {
    await execute(from.executable, [script, directory, transport.origin], {
      env: { ...upgradeUserEnvironment(process.env, directory), ELECTRON_RUN_AS_NODE: '1' },
      timeout: 120_000,
      windowsHide: true,
    })
    const { downloadedBytes, rangeRequests } = transport.stats()
    assert.equal(downloadedBytes, expectedBytes)
    return {
      fromSha256: from.sha256,
      toSha256: target.sha256,
      downloadedBytes,
      archiveBytes: target.bytes,
      rangeRequests,
    }
  } finally {
    await transport.close()
  }
}

async function startDeltaServer(from, target, sourceIndex, targetIndex) {
  const indexes = new Map([
    [`/${from.name}.blocks`, sourceIndex],
    [`/${target.name}.blocks`, targetIndex],
  ])
  let downloadedBytes = 0
  let rangeRequests = 0
  const server = createServer((request, response) => {
    const index = indexes.get(request.url)
    if (index) {
      downloadedBytes += index.length
      response.writeHead(200, { 'content-length': index.length }).end(index)
      return
    }
    if (request.url !== `/${target.name}`) {
      response.writeHead(404).end()
      return
    }
    const bounds = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    const start = bounds ? Number(bounds[1]) : 0
    const end = bounds ? Number(bounds[2]) : target.bytes - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      end >= target.bytes
    ) {
      response.writeHead(416).end()
      return
    }
    const bytes = end - start + 1
    downloadedBytes += bytes
    if (bounds) rangeRequests++
    response.writeHead(bounds ? 206 : 200, {
      'content-length': bytes,
      ...(bounds ? { 'content-range': `bytes ${start}-${end}/${target.bytes}` } : {}),
    })
    const body = createReadStream(target.path, { start, end })
    body.on('error', error => response.destroy(error))
    response.on('close', () => body.destroy())
    body.pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stats: () => ({ downloadedBytes, rangeRequests }),
    close: () =>
      new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      }),
  }
}
