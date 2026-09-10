import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function verifyTrayPositionPersistence(control, appIdentifier, restartDesktopApp) {
  assert.ok(appIdentifier.startsWith('io.wecode.wework.e2e.'), 'Use an isolated application domain')
  assert.equal(typeof restartDesktopApp, 'function')
  const original = JSON.parse(await control.command('getTraySnapshot', 'body'))
  assert.ok(original.created && original.guid, 'A native tray must exist before seeding placement')
  const key = `NSStatusItem Preferred Position ${original.guid}`
  const readPosition = async () => {
    const { stdout } = await execFileAsync('/usr/bin/defaults', ['read', appIdentifier, key])
    return Number(stdout.trim())
  }

  // Seed the same AppKit preference that a user moving the native item writes.
  // Explicit Tray.destroy() removes this key even when the GUID is unchanged.
  await execFileAsync('/usr/bin/defaults', ['write', appIdentifier, key, '-int', '417'])
  try {
    assert.equal(await readPosition(), 417)
    await restartDesktopApp({
      afterStop: async () => {
        assert.equal(await readPosition(), 417, 'Exiting Wework erased the native tray position')
      },
    })
    const restarted = JSON.parse(await control.command('getTraySnapshot', 'body'))
    assert.equal(restarted.created, true)
    assert.equal(
      restarted.guid,
      original.guid,
      'Restarting Wework changed the native tray identity'
    )
    assert.equal(await readPosition(), 417, 'Restarting Wework reset the native tray position')
  } finally {
    // Delete only this test-owned key; deleting a missing key must not mask a failure.
    await execFileAsync('/usr/bin/defaults', ['delete', appIdentifier, key]).catch(error => {
      if (!String(error.stderr).includes('does not exist')) throw error
    })
  }
}
