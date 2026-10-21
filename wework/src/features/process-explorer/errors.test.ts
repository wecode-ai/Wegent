import { describe, expect, it } from 'vitest'
import { describeDegradation } from './errors'

const translations: Record<string, string> = {
  'process_explorer.degraded_reason.system_process_table_failed':
    'The system process table could not be read',
}
const t = (key: string) => translations[key] ?? key

describe('process explorer message mapping', () => {
  it('maps known degradation codes and falls back to the detail', () => {
    expect(describeDegradation({ code: 'system-process-table-failed', detail: 'timeout' }, t)).toBe(
      'The system process table could not be read'
    )
    expect(describeDegradation({ code: 'unknown' as never, detail: 'detail' }, t)).toBe('detail')
  })
})
