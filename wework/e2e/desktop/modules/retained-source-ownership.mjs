import assert from 'node:assert/strict'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'

async function assertOwned(path, parent) {
  const child = relative(await realpath(parent), await realpath(path))
  assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function resources(executable) {
  return process.platform === 'darwin'
    ? resolve(dirname(executable), '../Resources')
    : join(dirname(executable), 'resources')
}

/** A stopped live profile and a shipped legacy rollback copy have different owners. */
export async function assertRetainedSourceOwnership({
  baseline,
  slot,
  running,
  original,
  data,
  retainsLiveProfile,
}) {
  const retained = await stat(baseline.profileRoot, { bigint: true })
  assert.ok(retained.isDirectory(), 'The retained profile is not a directory')
  assert.equal(retained.dev, original.dev, 'The retained profile moved to another filesystem')
  if (retainsLiveProfile) {
    assert.equal(baseline.executable, running.hostExecutable, 'The running host was copied')
    assert.equal(
      await realpath(join(baseline.componentDataDirectory, 'managed-components')),
      await realpath(join(data, 'managed-components')),
      'The running components were replaced'
    )
    assert.equal(
      retained.ino,
      original.ino,
      'Rollback must retain the original stopped profile, rather than prepare a copy'
    )
    return
  }
  // Delivered 0.6.2 and older Beta installers copy/prepare their rollback host
  // before B starts. Validate that exact legacy copy instead of requiring the
  // newer updater's live-profile retention protocol from immutable old code.
  const releaseRoot = await realpath(join(data, 'releases'))
  const slots = await realpath(join(data, 'releases', 'slots'))
  assert.equal(slots, join(releaseRoot, 'slots'))
  const ownedSlot = await realpath(slot)
  assert.equal(ownedSlot, join(slots, baseline.id))
  assert.equal(await realpath(join(slot, 'host')), join(ownedSlot, 'host'))
  await assertOwned(baseline.executable, join(slot, 'host'))
  await assertOwned(baseline.resources, join(slot, 'host'))
  await assertOwned(baseline.profileRoot, slot)
  assert.equal((await lstat(baseline.profileRoot)).isSymbolicLink(), false)
  assert.notEqual(
    retained.ino,
    original.ino,
    'The legacy fixture did not prepare its rollback copy'
  )
  for (const [copy, delivered] of [
    [baseline.executable, running.hostExecutable],
    [join(baseline.resources, 'app.asar'), join(resources(running.hostExecutable), 'app.asar')],
  ])
    assert.equal(
      await hashReleaseAsset(copy),
      await hashReleaseAsset(delivered),
      'The legacy rollback host differs from the delivered source'
    )
}
