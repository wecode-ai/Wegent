import { spawn } from 'node:child_process'

export function keepVerificationHostAwake() {
  if (process.platform !== 'darwin') return
  const awake = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], {
    stdio: 'ignore',
  })
  awake.once('error', error => {
    throw error
  })
  awake.unref()
  process.once('exit', () => awake.kill())
}
