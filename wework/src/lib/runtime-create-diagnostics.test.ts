import { describe, expect, it } from 'vitest'
import { runtimeOriginDiagnostic } from './runtime-create-diagnostics'

describe('runtime origin diagnostic privacy', () => {
  it('classifies origin markers without exposing private source values', () => {
    const details = runtimeOriginDiagnostic({
      type: 'board_task',
      initiatedBy: 'stand_in',
      dispatchRole: '',
      dispatch_role: 'executor',
      dispatchId: 'private-dispatch-id',
      dispatch_id: false,
      auth_token: 'private-token',
    })
    expect(details).toEqual({
      originPresent: true,
      originMarkers: {
        type: 'board_task',
        initiatedBy: 'stand_in',
        dispatchRole: 'empty_string',
        dispatch_role: 'executor',
        dispatchId: 'nonempty_string',
        dispatch_id: 'non_string',
      },
    })
    expect(JSON.stringify(details)).not.toContain('private-')
    for (const missing of [undefined, null, false, [], 'private-token']) {
      expect(runtimeOriginDiagnostic(missing)).toEqual({ originPresent: false })
    }
  })
})
