import { spawn } from 'node:child_process'

export function keepVerificationHostAwake() {
  if (process.platform !== 'darwin') return
  const awake = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], {
    stdio: 'ignore',
  })
  awake.once('error', error => {
    console.warn('[verification] Unable to keep the host awake:', error.message)
  })
  awake.unref()
  process.once('exit', () => awake.kill())
}
