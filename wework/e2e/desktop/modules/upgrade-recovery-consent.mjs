import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { clickMacosNativeDecision, clickNativeDecision } from './native-plugin-approval.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const execute = promisify(execFile)

/** Confirm snapshot recovery through the real native dialog after the failed trial. */
export async function confirmUpgradeRecovery(root, timeoutMs) {
  if (process.platform === 'win32') {
    const pid = await waitForValue(
      async () => {
        try {
          return Number(await readFile(join(root, 'recovery-pid'), 'utf8'))
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      },
      value => Number.isSafeInteger(value) && value > 0,
      'The failed trial did not launch native recovery',
      timeoutMs
    )
    await clickNativeDecision(pid, true, new AbortController().signal, undefined, {
      focus: true,
      titles: ['Wework', 'WeWork'],
      labels: ['Restore and roll back', '恢复并回退'],
    })
    console.log('[upgrade-e2e] Explicitly confirmed native snapshot restoration')
    return
  }
  assert.equal(process.platform, 'darwin')
  const pid = await waitForValue(
    async () => {
      try {
        await readFile(join(root, 'recovery-pid'), 'utf8')
        const bridge = (await readFile(join(root, 'bridge'), 'utf8')).trim()
        const { stdout } = await execute(
          '/usr/bin/osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            `
ObjC.import('AppKit')
const apps = $.NSWorkspace.sharedWorkspace.runningApplications
const matches = []
for (let i = 0; i < apps.count; i++) {
  const app = apps.objectAtIndex(i)
  if (app.executableURL && ObjC.unwrap(app.executableURL.path) === ${JSON.stringify(bridge)})
    matches.push(Number(app.processIdentifier))
}
JSON.stringify(matches)
`,
          ],
          { timeout: 10_000 }
        )
        const matches = JSON.parse(stdout)
        assert.ok(matches.length < 2, 'Recovery must have exactly one native owner')
        return matches[0]
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    },
    value => Number.isSafeInteger(value) && value > 0,
    'The failed trial did not open its native recovery host',
    timeoutMs
  )
  await clickMacosNativeDecision(pid, ['Restore and roll back', '恢复并回退'], { timeout: 12_000 })
  console.log('[upgrade-e2e] Explicitly confirmed snapshot restoration in the native dialog')
}
