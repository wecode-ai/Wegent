import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  componentResourceChanges,
  inventoryComponentResources,
} from '../e2e/desktop/modules/packaged-plugin-resource-integrity.mjs'

test('resource inventory identifies exact changed, added, removed and replaced entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-resource-inventory-'))
  try {
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets/main.js'), 'before')
    await writeFile(join(root, 'removed.js'), 'removed')
    await writeFile(join(root, 'replacement'), 'file')
    const before = await inventoryComponentResources(root)
    await writeFile(join(root, 'assets/main.js'), 'after')
    await rm(join(root, 'removed.js'))
    await rm(join(root, 'replacement'))
    await mkdir(join(root, 'replacement'))
    await writeFile(join(root, 'added.js'), 'added')
    const after = await inventoryComponentResources(root)
    const changes = componentResourceChanges(before, after)
    assert.deepEqual(Object.keys(changes), [
      'added.js',
      'assets/main.js',
      'removed.js',
      'replacement',
    ])
    assert.equal(changes['added.js'].before, null)
    assert.equal(changes['removed.js'].after, null)
    assert.equal(changes.replacement.before.type, 'file')
    assert.equal(changes.replacement.after.type, 'directory')
    assert.notEqual(changes['assets/main.js'].before.sha256, changes['assets/main.js'].after.sha256)
    assert.deepEqual(componentResourceChanges(after, after), {})
    assert.equal(JSON.stringify(changes).includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resource inventory hashes junction targets without traversing or revealing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-resource-link-inventory-'))
  try {
    const resources = join(root, 'resources')
    const external = join(root, 'private-external-directory')
    await mkdir(resources)
    await mkdir(external)
    await writeFile(join(external, 'private-content.js'), 'private-content')
    await symlink(
      external,
      join(resources, 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const inventory = await inventoryComponentResources(resources)
    assert.deepEqual(Object.keys(inventory), ['assets'])
    assert.equal(inventory.assets.type, 'symlink')
    assert.match(inventory.assets.sha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(inventory).includes(external), false)
    assert.equal(JSON.stringify(inventory).includes('private-content'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
