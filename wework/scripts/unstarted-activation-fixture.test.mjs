import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { retainUnstartedSourceComponents } from '../e2e/desktop/modules/unstarted-activation-fixture.mjs'

test('binds legacy selected-slot component paths to the real installed immutable programs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-unstarted-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  const slot = join(data, 'releases/slots/installed-unstarted-source')
  const installed = join(data, 'managed-components/composed/core')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'index.js'), 'delivered source program')
  const packaged = join(root, 'immutable-host/resources/executor')
  const components = await retainUnstartedSourceComponents(data, slot, {
    weworkCorePlugins: installed,
    executor: packaged,
    similarlyNamed: join(data, 'managed-components-other/program'),
  })
  assert.equal(components.weworkCorePlugins, join(slot, 'managed-components/composed/core'))
  assert.equal(await realpath(components.weworkCorePlugins), await realpath(installed))
  assert.equal(components.executor, packaged)
  assert.equal(components.similarlyNamed, join(data, 'managed-components-other/program'))
  await rm(slot, { recursive: true, force: true })
  assert.equal(await readFile(join(installed, 'index.js'), 'utf8'), 'delivered source program')
})
