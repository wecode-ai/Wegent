let installed = false

export function installAppLogging() {
  if (installed) return
  installed = true
  console.info('Frontend logging initialized')
}
