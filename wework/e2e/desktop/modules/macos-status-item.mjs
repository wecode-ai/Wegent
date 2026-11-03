import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Verify the system hosted the item, beyond Electron having a Tray instance. */
export async function assertMacosStatusItem(control, pid, resultDir, version) {
  if (process.platform !== 'darwin') return
  const tray = JSON.parse(await control.command('getTraySnapshot', 'body'))
  assert.equal(tray.created, true)
  assert.match(tray.guid, /^[a-f0-9-]{36}$/)
  const script = `
ObjC.import('CoreGraphics')
const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)))
JSON.stringify(windows.filter(window => window.kCGWindowLayer === 25 &&
  (window.kCGWindowName === ${JSON.stringify(tray.guid)} || window.kCGWindowOwnerPID === ${pid})))
`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])
    const items = JSON.parse(stdout)
    if (items.some(item => item.kCGWindowBounds.Width > 0)) {
      await writeFile(
        join(resultDir, `macos-status-item-${version}-result.json`),
        JSON.stringify({ pid, guid: tray.guid, items }, null, 2)
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const { stdout } = await execute('/usr/bin/log', [
    'show',
    '--last',
    '2m',
    '--style',
    'compact',
    '--predicate',
    `process == "ControlCenter" AND eventMessage CONTAINS "${pid}"`,
  ])
  await writeFile(join(resultDir, `macos-status-item-${version}-failure.log`), stdout)
  assert.fail(`macOS did not host the native status item for PID ${pid}; see ControlCenter log`)
}
