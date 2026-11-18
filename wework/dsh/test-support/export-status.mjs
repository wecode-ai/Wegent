export async function waitForTerminalStatus(methods, exportTaskId) {
  for (;;) {
    const status = await methods.status({ exportTaskId })
    if (!['writing', 'finalizing'].includes(status.state)) return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
