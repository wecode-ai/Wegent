// @vitest-environment node
import { expect, test } from 'vitest'
import { isTranscriptReadAdmissionBusy } from '../e2e/desktop/modules/runtime-read-admission.mjs'

const busy = JSON.stringify({
  detail: 'Transcript processing is busy; try again when the current read finishes',
})

test('recognizes the exact transient read-admission response', () => {
  expect(isTranscriptReadAdmissionBusy(502, busy)).toBe(true)
})

test.each([
  [200, busy],
  [401, busy],
  [403, busy],
  [500, busy],
  [502, JSON.stringify({ detail: 'Permission denied' })],
  [502, JSON.stringify({ detail: 'Task not found' })],
  [502, JSON.stringify({ detail: 'Runtime disconnected' })],
  [502, 'Upstream failed'],
])('does not defer HTTP %s or an unrelated failure', (status, text) => {
  expect(isTranscriptReadAdmissionBusy(status, text)).toBe(false)
})
