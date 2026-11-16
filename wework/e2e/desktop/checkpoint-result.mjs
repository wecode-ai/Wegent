import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Process status alone cannot prove a scenario passed when assertion evidence
// was persisted. Recorded failures must never pass CI.
export async function rejectRecordedCheckpointFailure(result) {
  if (result.code !== 0 || !result.resultDir) return result
  try {
    await readFile(join(result.resultDir, 'failure.txt'), 'utf8')
    return { ...result, code: 1 }
  } catch (error) {
    if (error.code === 'ENOENT') return result
    throw error
  }
}
