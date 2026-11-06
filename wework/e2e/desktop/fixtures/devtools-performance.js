function diagnosticHotFunction() {
  const deadline = performance.now() + 90
  while (performance.now() < deadline) Math.sqrt(Math.random())
}
diagnosticHotFunction()
console.info('DEVTOOLS_PERFORMANCE_FIXTURE')
console.info({ marker: 'DEVTOOLS_REMOTE_OBJECT' })
