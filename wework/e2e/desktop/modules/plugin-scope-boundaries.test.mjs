import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('catalog navigation uses visible product controls and refresh prerequisites', async () => {
  const source = await readFile(new URL('./plugin-scope-boundaries.mjs', import.meta.url), 'utf8')
  const catalog = source.slice(
    source.indexOf('async function backToCatalog()'),
    source.indexOf('async function refreshCatalog()')
  )
  assert.ok(
    catalog.indexOf("command('click', testId('plugins-button')") >= 0,
    'Catalog navigation must use the product plugin entry'
  )
  assert.ok(
    catalog.indexOf("command('waitFor', testId('plugins-search-input')") >= 0,
    'The catalog must be visible before any detail or refresh action'
  )
  assert.ok(
    catalog.indexOf("command('clickIfPresent', testId(id)") >= 0,
    'Route back actions must skip hidden controls retained by another window'
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
