import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const COMMAND_EVIDENCE_FIELDS = [
  'id',
  'action',
  'selector',
  'timeoutMs',
  'clientId',
  'queuedAt',
  'deliveredAt',
  'responseFinishedAt',
  'startedAt',
  'resultReceivedAt',
  'failedAt',
  'lateResultAt',
  'actionSucceeded',
]

const MODEL_EVIDENCE_FIELDS = ['body', 'scenario', 'failed', 'protocol', 'httpRequestIndex']

function evidenceRecords(records, fields) {
  return records.map(record =>
    Object.fromEntries(
      fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]])
    )
  )
}

export function modelRequestEvidence(requests) {
  return evidenceRecords(requests, MODEL_EVIDENCE_FIELDS)
}

/** Save partial evidence before cleanup; it never certifies a final outcome. */
export async function persistDesktopCommandEvidence({ control, resultDir, teardownFailures }) {
  for (const [name, value] of [
    ['model-requests.json', modelRequestEvidence(control.modelRequests)],
    ['http-requests.json', control.httpRequests],
    ['command-history.json', evidenceRecords(control.commandHistory, COMMAND_EVIDENCE_FIELDS)],
  ]) {
    try {
      await writeFile(join(resultDir, name), JSON.stringify(value, null, 2))
    } catch (error) {
      teardownFailures.push({ error, label: name })
    }
  }
}

/** Persist the final outcome only after all lifecycle steps have settled. */
export async function finishDesktopTeardown({
  control,
  resultDir,
  testFailed,
  teardownFailures,
  cleanupError,
}) {
  if (control.fatalError && !teardownFailures.some(step => step.error === control.fatalError))
    teardownFailures.push({ error: control.fatalError, label: 'desktop controller' })
  await persistDesktopCommandEvidence({ control, resultDir, teardownFailures })
  try {
    const passed = !testFailed && !control.fatalError && !teardownFailures.length && !cleanupError
    await writeFile(
      join(resultDir, 'performance.json'),
      JSON.stringify(control.performance.report(passed), null, 2)
    )
  } catch (error) {
    teardownFailures.push({ error, label: 'performance evidence' })
  }
  for (const failure of teardownFailures)
    console.error(`[desktop-e2e] ${failure.label} teardown failed:`, failure.error)
  if (testFailed) {
    if (cleanupError) console.error(`[desktop-e2e] result cleanup failed: ${String(cleanupError)}`)
    return
  }
  const failure = teardownFailures.length
    ? new AggregateError(
        teardownFailures.map(step => step.error),
        `Desktop E2E teardown failed: ${teardownFailures.map(step => step.label).join(', ')}`
      )
    : cleanupError
  if (!failure) return
  try {
    await writeFile(
      join(resultDir, 'failure.txt'),
      `${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}\n`
    )
  } catch (error) {
    console.error('[desktop-e2e] failure evidence could not be written:', error)
  }
  throw failure
}
