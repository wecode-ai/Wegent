import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('catalog navigation restores desktop sidebar and visible refresh prerequisites', async () => {
  const source = await readFile(new URL('./plugin-scope-boundaries.mjs', import.meta.url), 'utf8')
  const catalog = source.slice(
    source.indexOf('async function backToCatalog()'),
    source.indexOf('async function refreshCatalog()')
  )
  assert.ok(
    catalog.indexOf("command('setMainWindowSize'") >= 0,
    'Catalog navigation must establish the desktop breakpoint after a restart'
  )
  assert.ok(
    catalog.indexOf("command('getElementCount', expandSidebar") >= 0,
    'Catalog navigation must detect a preserved collapsed sidebar'
  )
  assert.ok(
    catalog.indexOf("command('click', expandSidebar") >= 0,
    'A collapsed sidebar must be restored through the real product control'
  )

  const refresh = source.slice(
    source.indexOf('async function refreshCatalog()'),
    source.indexOf('async function openComposer()')
  )
  const visible = refresh.indexOf('visible: true')
  const click = refresh.indexOf("command('clickWhenEnabled'")
  assert.ok(visible >= 0, 'The desktop-only control must be observed visible before clicking')
  assert.ok(click > visible, 'The real refresh must run only after its prerequisites are ready')
})
