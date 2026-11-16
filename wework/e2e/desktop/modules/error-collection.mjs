export async function verifyErrorCollection(control, timeoutMs) {
  const after = control.errors.mark()
  await control.command('probeErrorCollection', 'body')
  const match = event => event.source === 'renderer' && event.type === 'collector-probe'
  await control.errors.waitForRecord(match, { after, timeoutMs })
  await control.errors.assertCollectedErrors(control, [{ match, count: 1 }], {
    after,
    source: 'renderer',
    type: 'collector-probe',
    sources: [
      'main',
      'renderer',
      'runtime',
      'network',
      'host-pipe',
      'process',
      'worker',
      'electron-child',
    ],
  })
}
