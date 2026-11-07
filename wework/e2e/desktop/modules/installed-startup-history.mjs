import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A manual package replacement must not be undone by old updater selection. */
export async function assertInstalledStartupWithStaleHistory({
  root,
  restartDesktopApp,
  installedVersion,
  expectedVersion,
  control,
  timeoutMs,
}) {
  const active = await readFile(join(root, 'active'), 'utf8')
  const bridge = await readFile(join(root, 'bridge'), 'utf8')
  const previous = await readFile(join(root, 'previousHealthy'), 'utf8')
  assert.notEqual(previous.trim(), active.trim())
  try {
    await restartDesktopApp({
      afterStop: async () => {
        await writeFile(join(root, 'active'), previous)
        await writeFile(join(root, 'bridge'), join(root, 'missing-old-host'))
      },
    })
    assert.equal(
      await installedVersion(),
      expectedVersion,
      'Old release history overrode the package the user opened'
    )
    await control.command(
      'waitFor',
      '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
      { timeoutMs }
    )
  } finally {
    await writeFile(join(root, 'active'), active)
    await writeFile(join(root, 'bridge'), bridge)
  }
}
