import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { assertRetainedSourceOwnership } from '../e2e/desktop/modules/retained-source-ownership.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retained-source-ownership-'))
  const noAsar = process.noAsar
  // Match the release verifier's physical archive filesystem.
  process.noAsar = true
  t.after(async () => {
    try {
      await rm(root, { recursive: true, force: true })
    } finally {
      process.noAsar = noAsar
    }
  })
  const data = join(root, 'data')
  const profile = join(data, 'dsh-core/profiles/wework-core')
  const originalPrograms = join(data, 'managed-components')
  const hostExecutable =
    process.platform === 'darwin'
      ? join(root, 'installed/WeWork.app/Contents/MacOS/WeWork')
      : join(root, 'installed/WeWork.exe')
  const resources =
    process.platform === 'darwin'
      ? resolve(dirname(hostExecutable), '../Resources')
      : join(dirname(hostExecutable), 'resources')
  for (const directory of [profile, originalPrograms, dirname(hostExecutable), resources])
    await mkdir(directory, { recursive: true })
  await writeFile(hostExecutable, 'exact delivered executable')
  await writeFile(join(resources, 'app.asar'), 'exact delivered application archive')
  await writeFile(join(profile, 'package.json'), '{"private":true}')
  const id = 'installed-legacy-source'
  const slot = join(data, 'releases/slots', id)
  await mkdir(slot, { recursive: true })
  const baseline = {
    id,
    executable: hostExecutable,
    resources,
    profileRoot: profile,
    componentDataDirectory: data,
  }
  const options = {
    baseline,
    slot,
    running: { hostExecutable },
    original: await stat(profile, { bigint: true }),
    data,
    retainsLiveProfile: true,
  }
  const prepareLegacyCopy = async () => {
    await cp(join(root, 'installed'), join(slot, 'host/installed'), { recursive: true })
    baseline.executable = join(
      slot,
      'host/installed',
      process.platform === 'darwin' ? 'WeWork.app/Contents/MacOS/WeWork' : 'WeWork.exe'
    )
    baseline.resources =
      process.platform === 'darwin'
        ? resolve(dirname(baseline.executable), '../Resources')
        : join(dirname(baseline.executable), 'resources')
    baseline.profileRoot = join(slot, 'profile')
    await cp(profile, baseline.profileRoot, { recursive: true })
    delete baseline.componentDataDirectory
    options.retainsLiveProfile = false
  }
  return { ...options, options, prepareLegacyCopy, root }
}

test('keeps every stopped-live-profile ownership assertion', async t => {
  const f = await fixture(t)
  await assertRetainedSourceOwnership(f.options)
  await f.prepareLegacyCopy()
  await assert.rejects(assertRetainedSourceOwnership({ ...f.options, retainsLiveProfile: true }), {
    code: 'ERR_ASSERTION',
  })
})

test('validates the immutable legacy host copy and its independently prepared profile', async t => {
  const f = await fixture(t)
  await f.prepareLegacyCopy()
  await assertRetainedSourceOwnership(f.options)
})

for (const changed of ['executable', 'archive', 'profile-owner', 'host-alias']) {
  test(`rejects a legacy rollback copy with changed ${changed}`, async t => {
    const f = await fixture(t)
    await f.prepareLegacyCopy()
    if (changed === 'executable') await writeFile(f.baseline.executable, 'foreign executable')
    if (changed === 'archive')
      await writeFile(join(f.baseline.resources, 'app.asar'), 'foreign application')
    if (changed === 'profile-owner')
      f.baseline.profileRoot = join(f.data, 'dsh-core/profiles/wework-core')
    if (changed === 'host-alias') {
      const host = join(f.slot, 'host')
      const outside = join(f.root, 'foreign-host')
      await rename(host, outside)
      await symlink(outside, host, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await assert.rejects(assertRetainedSourceOwnership(f.options), { code: 'ERR_ASSERTION' })
  })
}
