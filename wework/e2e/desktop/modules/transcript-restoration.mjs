export async function waitForTranscriptState(
  control,
  predicate,
  description,
  timeoutMs,
  recordSample
) {
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt < timeoutMs) {
    latest = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const matched = predicate(latest)
    await recordSample?.({ matched, snapshot: latest })
    if (matched) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description}: ${JSON.stringify(latest?.pane?.transcript ?? null)}`)
}

export function waitForRestoredTranscript(control, taskId, timeoutMs) {
  return waitForTranscriptState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The conversation did not finish restoration',
    timeoutMs
  )
}
