import { spawn } from 'node:child_process'

export function keepVerificationHostAwake() {
  if (process.platform !== 'darwin') return
  // Request a full user wake, then hold the display and idle assertions on battery too.
  const awake = spawn('/usr/bin/caffeinate', ['-disu', '-w', String(process.pid)], {
    stdio: 'ignore',
  })
  awake.once('error', error => {
    console.warn('[verification] Unable to keep the host awake:', error.message)
  })
  awake.unref()
  process.once('exit', () => awake.kill())
}
