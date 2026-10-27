import { expect, test } from 'vitest'
import { assertUnrelatedPluginPreserved } from '../e2e/desktop/modules/plugin-upgrade-flow.mjs'

const managed = {
  version: '0.1.1',
  checksum: 'original',
  component_states: { 'skill:existing': true },
  plugin_sync_generation: 11,
  updated_at: 'before',
}
const snapshot = (plugin, generation = 7) => ({
  plugins: { existing: plugin },
  plugin_sync: { complete_generation: generation },
})

test('preserves an unrelated plugin during delta installs', () => {
  assertUnrelatedPluginPreserved(managed, snapshot({ ...managed }), 'existing')
  expect(() =>
    assertUnrelatedPluginPreserved(
      managed,
      snapshot({ ...managed, plugin_sync_generation: 22 }),
      'existing'
    )
  ).toThrow('Only a newer complete snapshot')
})

test('accepts complete-sync metadata without accepting package or component changes', () => {
  const refreshed = { ...managed, plugin_sync_generation: 32, updated_at: 'after' }
  assertUnrelatedPluginPreserved(managed, snapshot(refreshed, 32), 'existing')
  for (const changed of [
    { version: '0.3.1' },
    { checksum: 'changed' },
    { component_states: {} },
    { plugin_sync_generation: 10 },
  ]) {
    expect(() =>
      assertUnrelatedPluginPreserved(
        managed,
        snapshot({ ...refreshed, ...changed }, 32),
        'existing'
      )
    ).toThrow()
  }
})
