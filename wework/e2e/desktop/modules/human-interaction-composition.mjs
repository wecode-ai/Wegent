import assert from 'node:assert/strict'

/** Reuse the live pending question and its existing submit/persistence assertions. */
export async function verifyPendingAnswerComposition(control, selector, answer) {
  const result = JSON.parse(
    await control.command('composeInput', selector, {
      value: JSON.stringify(['bao', 'baoliu', answer]),
    })
  )
  assert.deepEqual(
    result.writes,
    [],
    'The application must never rewrite the input value during IME composition'
  )
  for (const step of result.steps) {
    assert.equal(step.actual, step.value, 'Composition text must survive shared draft updates')
    assert.equal(step.focused, true, 'Composition must retain focus')
    assert.equal(step.connected, true, 'Composition must not remount the answer input')
  }
  assert.equal(result.value, answer, 'The committed Chinese answer must remain in the input')
}
