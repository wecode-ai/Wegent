import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readNativeProcessIdentity } from '../process-identity.mjs'

if (process.argv[2] === 'service') {
  setInterval(() => {}, 1000)
} else {
  let stopping = false
  const startService = replacement => {
    const service = fork(fileURLToPath(import.meta.url), ['service'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    process.send({
      servicePid: service.pid,
      replacement,
      identity: readNativeProcessIdentity(service.pid),
    })
    service.once('exit', () => {
      if (!stopping) startService(true)
    })
  }
  process.on('SIGTERM', () => {
    stopping = true
    process.exit(0)
  })
  startService(false)
  setInterval(() => {}, 1000)
}
