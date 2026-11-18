import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { windowsNativeWindowDiagnosticScript } from '../e2e/desktop/modules/native-plugin-window-diagnostics.mjs'

assert.equal(process.platform, 'win32', 'This verification requires real Windows APIs')
const script = windowsNativeWindowDiagnosticScript(process.pid, [
  'WEWORK_E2E_READONLY_OBSERVER_NO_DIALOG',
])
const stdout = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Mta',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  { timeout: 4_000, encoding: 'utf8' }
)
for (const stage of ['observer-types-loaded', 'observer-dialog-missing', 'observer-completed'])
  assert.ok(
    stdout.split(/\r?\n/).includes(`native-decision:${stage}`),
    `Missing native stage: ${stage}`
  )
assert.doesNotMatch(stdout, /observer-failed|observer-dialog-matched|native-decision-structure:/)
console.log('Native Win32 diagnostic compiled and enumerated without fabricating a missing dialog')
