import { Session } from 'node:inspector'

// V8's profiler clock can have a different origin from process.hrtime.
// A separate, short profile supplies an endpoint in the same clock domain.
export function captureCpuProfileEndpoint() {
  const session = new Session()
  session.connect()
  try {
    session.post('Profiler.enable')
    session.post('Profiler.start')
    let endpoint
    let failure
    session.post('Profiler.stop', (error, result) => {
      failure = error
      endpoint = result?.profile.startTime
    })
    if (failure || !Number.isFinite(endpoint)) throw new Error('CPU profile clock unavailable')
    return endpoint
  } finally {
    session.disconnect()
  }
}
