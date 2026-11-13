// PowerShell compiles its native handle helper on first use, which can exceed
// the desktop step budget on a loaded Windows runner.
const HOLDER_READY_TIMEOUT_MS = 30_000

export function waitForNativeFileHolder(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    const finish = error => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('close', onClose)
      child.stdout.off('data', onOutput)
      child.stderr.off('data', onStderr)
      error ? reject(error) : resolve()
    }
    const diagnostic = message =>
      new Error(
        `${message}; pid=${child.pid ?? 'unavailable'}; stderr=${stderr.trim() || '(empty)'}`
      )
    const onError = error =>
      finish(diagnostic(`Native file holder failed to start: ${error.message}`))
    const onClose = (code, signal) =>
      finish(
        diagnostic(`Native file holder exited before readiness: code=${code}, signal=${signal}`)
      )
    const onStderr = data => {
      stderr = (stderr + data.toString()).slice(-4096)
    }
    const onOutput = data => {
      output += data.toString()
      const newline = output.indexOf('\n')
      if (newline === -1) return
      finish(
        output.slice(0, newline).trim() === 'held'
          ? undefined
          : diagnostic('Invalid native holder acknowledgement')
      )
    }
    const timer = setTimeout(
      () =>
        finish(diagnostic(`Native file holder did not start within ${HOLDER_READY_TIMEOUT_MS}ms`)),
      HOLDER_READY_TIMEOUT_MS
    )
    child.once('error', onError)
    child.once('close', onClose)
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onStderr)
  })
}
