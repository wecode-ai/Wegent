import { watchRemoteConnectionParent } from './remote-lifecycle.js'
import { runRemoteConnectionService } from './remote-service-runtime.js'

watchRemoteConnectionParent()
try {
  await runRemoteConnectionService(process.argv.slice(2))
} catch {
  console.error('Connection service failed to start')
  process.exit(1)
}
