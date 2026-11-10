import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRunningApp } from './inspect-before-start.mjs'
import { nativeTrayStateScript } from './native-tray-state.mjs'

/** Electron reads the actual NSWindow frame; a JavaScript instance alone is insufficient. */
export async function assertMacosStatusItem(control, pid, resultDir, version, inspectorPort) {
  if (process.platform !== 'darwin') return
  const tray = JSON.parse(await control.command('getTraySnapshot', 'body'))
  assert.equal(tray.created, true)
  assert.match(tray.guid, /^[a-f0-9-]{36}$/)
  const deadline = Date.now() + 10_000
  let state
  while (Date.now() < deadline) {
    state = await inspectRunningApp(inspectorPort, pid, nativeTrayStateScript(tray.guid))
    assert.equal(state.pid, pid)
    assert.ok(state.items.length <= 1, 'Multiple native status items have the application GUID')
    const item = state.items[0]
    if (item && hostedStatusItem(item)) {
      await writeFile(
        join(resultDir, `macos-status-item-${version}-result.json`),
        JSON.stringify({ pid, ...item }, null, 2)
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await writeFile(
    join(resultDir, `macos-status-item-${version}-failure.json`),
    JSON.stringify(state)
  )
  assert.fail(
    `macOS did not host the native status item for PID ${pid}; see native window evidence`
  )
}

export function hostedStatusItem({ bounds, display }) {
  return (
    [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      display.x,
      display.y,
      display.width,
      display.height,
    ].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x >= display.x &&
    bounds.y >= display.y &&
    bounds.x + bounds.width <= display.x + display.width &&
    bounds.y + bounds.height <= display.y + display.height
  )
}
