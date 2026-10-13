import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, test } from 'vitest'

import { uploadComponentAssets } from './upload-desktop-component-assets.mjs'

const directories = []
const name = 'WeworkComponent_weworkAppStatic_test_macos_x64.tar.gz'
const content = 'component archive'
const asset = {
  name,
  state: 'uploaded',
  size: Buffer.byteLength(content),
  digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'wework-upload-'))
  directories.push(directory)
  await writeFile(resolve(directory, name), content)
  await writeFile(
    resolve(directory, 'components-macos-x64.json'),
    JSON.stringify({
      components: { weworkAppStatic: { assetName: name, releaseScope: 'version' } },
    })
  )
  return directory
}

function github(initialPages, uploadedPages, uploadError) {
  const calls = []
  let pages = initialPages
  const gh = args => {
    calls.push(args)
    if (args[0] === 'api') return JSON.stringify(pages)
    if (args[1] === 'view') return JSON.stringify({ apiUrl: 'https://api.github.com/releases/1' })
    pages = uploadedPages
    if (uploadError) throw uploadError
    return ''
  }
  return { gh, calls }
}

test('uploads a missing component once without clobbering immutable assets', async () => {
  const directory = await fixture()
  const { gh, calls } = github([[]], [[asset]])
  await uploadComponentAssets(directory, 'version', 'v1', gh, () => {})
  assert.deepEqual(calls.at(-1), ['release', 'upload', 'v1', resolve(directory, name)])
})

test('reuses a complete matching asset from a later API page', async () => {
  const directory = await fixture()
  const { gh, calls } = github([[], [asset]])
  await uploadComponentAssets(directory, 'version', 'v1', gh, () => {})
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('--paginate'))
})

test('confirms an upload that completed before gh reported a duplicate', async () => {
  const directory = await fixture()
  const error = new Error('HTTP 422: ReleaseAsset.name already exists')
  const { gh, calls } = github([[]], [[asset]], error)
  const messages = []
  await uploadComponentAssets(directory, 'version', 'v1', gh, message => messages.push(message))
  assert.equal(calls.filter(args => args[1] === 'upload').length, 1)
  assert.match(messages[0], /Confirmed completed component upload/)
})

test('preserves an upload failure when no remote asset exists', async () => {
  const directory = await fixture()
  const error = new Error('HTTP 403')
  const { gh } = github([[]], [[]], error)
  await assert.rejects(uploadComponentAssets(directory, 'version', 'v1', gh), error)
})

for (const invalid of [
  { ...asset, state: 'starter' },
  { ...asset, size: asset.size + 1 },
  { ...asset, digest: 'sha256:wrong' },
  { ...asset, digest: null },
]) {
  test(`rejects an existing unverified asset: ${JSON.stringify(invalid)}`, async () => {
    const directory = await fixture()
    const { gh, calls } = github([[invalid]])
    await assert.rejects(uploadComponentAssets(directory, 'version', 'v1', gh), /differs/)
    assert.equal(calls.length, 2)
  })

  test(`rejects an unverified asset after an upload error: ${JSON.stringify(invalid)}`, async () => {
    const directory = await fixture()
    const { gh } = github([[]], [[invalid]], new Error('HTTP 422'))
    await assert.rejects(uploadComponentAssets(directory, 'version', 'v1', gh), /differs/)
  })
}
