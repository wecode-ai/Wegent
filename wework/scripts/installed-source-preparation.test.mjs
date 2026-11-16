import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, toNamespacedPath } from 'node:path'
import test from 'node:test'
import { installPreparedSource } from '../e2e/desktop/modules/installed-source-preparation.mjs'

test('the installed source owns its shipped preparation without a selected release slot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-source-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  const slot = join(data, 'releases', 'slots', 'source-preparation')
  const components = join(slot, 'managed-components')
  const content = join(components, 'composed', '.content-checked')
  const publication = join(components, 'composed', 'fingerprint')
  const packaged = join(root, 'immutable-package')
  const profile = join(slot, 'profile')
  const liveProfile = join(data, 'dsh-core', 'profiles', 'wework-core')
  for (const directory of [content, packaged, profile, liveProfile])
    await mkdir(directory, { recursive: true })
  await writeFile(join(content, 'index.js'), 'checked component bytes')
  await writeFile(join(packaged, 'index.js'), 'immutable package bytes')
  await writeFile(join(liveProfile, '.wework-core-plugins.json'), 'original synthetic seed')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(toNamespacedPath(content), publication, linkType)
  await symlink(packaged, join(content, 'external'), linkType)
  await symlink(
    process.platform === 'win32' ? packaged : relative(content, packaged),
    join(content, 'relative-external'),
    linkType
  )
  await writeFile(join(profile, '.wework-core-plugins.json'), 'prepared disabled-plugin state')
  await writeFile(join(profile, '.prepared-stamp'), 'checked stamp')
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      dependencies: { composed: `file:${publication}`, packaged: `file:${packaged}` },
    })
  )
  const original = await lstat(join(content, 'index.js'))

  await installPreparedSource(slot, data)
  const installed = join(data, 'managed-components', 'composed', 'fingerprint')
  assert.equal((await lstat(join(installed, 'index.js'))).ino, original.ino)
  assert.equal(await readFile(join(installed, 'index.js'), 'utf8'), 'checked component bytes')
  assert.equal(await realpath(join(installed, 'external')), await realpath(packaged))
  assert.equal(await realpath(join(installed, 'relative-external')), await realpath(packaged))
  assert.deepEqual(
    JSON.parse(await readFile(join(liveProfile, 'package.json'), 'utf8')).dependencies,
    {
      composed: `file:${installed}`,
      packaged: `file:${packaged}`,
    }
  )
  assert.equal(await readFile(join(liveProfile, '.prepared-stamp'), 'utf8'), 'checked stamp')
  assert.equal(
    await readFile(join(liveProfile, '.wework-core-plugins.json'), 'utf8'),
    'prepared disabled-plugin state'
  )
  for (const marker of ['active', 'bridge'])
    await assert.rejects(lstat(join(data, 'releases', marker)), { code: 'ENOENT' })
  await rm(slot, { recursive: true })
  assert.equal(await readFile(join(installed, 'index.js'), 'utf8'), 'checked component bytes')
  assert.equal(await readFile(join(packaged, 'index.js'), 'utf8'), 'immutable package bytes')
})
