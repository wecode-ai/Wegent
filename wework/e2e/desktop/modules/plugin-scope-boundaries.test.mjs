import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('desktop catalog refresh establishes its window and visible control prerequisites', async () => {
  const source = await readFile(new URL('./plugin-scope-boundaries.mjs', import.meta.url), 'utf8')
  const refresh = source.slice(
    source.indexOf('async function refreshCatalog()'),
    source.indexOf('async function openComposer()')
  )
  const resize = refresh.indexOf("command('setMainWindowSize'")
  const visible = refresh.indexOf('visible: true')
  const click = refresh.indexOf("command('clickWhenEnabled'")
  assert.ok(resize >= 0, 'Refresh must establish the desktop breakpoint after a restart')
  assert.ok(visible > resize, 'The desktop-only control must be observed visible before clicking')
  assert.ok(click > visible, 'The real refresh must run only after its prerequisites are ready')
})
