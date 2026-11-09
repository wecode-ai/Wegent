import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForLocalStandInTask } from '../e2e/desktop/modules/stand-in-status-flows.mjs'

test('waits for the owning stand-in task to complete rather than treating receipt as completion', async () => {
  const states = ['running', 'done']
  const binding = { task_id: 'native-task' }
  const rpc = async (method, params) => {
    if (method === 'todos.bindings') {
      assert.equal(params.task_id, 'issue')
      return [binding]
    }
    assert.equal(method, 'runtime.tasks.get')
    assert.equal(params.taskId, binding.task_id)
    return { task: { status: states.shift() } }
  }
  assert.equal(await waitForLocalStandInTask(rpc, { id: 'issue' }, 1000), binding)
  assert.equal(states.length, 0)
})

test('rejects duplicate owning stand-in tasks', async () => {
  await assert.rejects(
    waitForLocalStandInTask(
      async () => [{ task_id: 'one' }, { task_id: 'two' }],
      { id: 'issue' },
      1000
    ),
    /Duplicate stand-in tasks/
  )
})

test('does not accept a failed stand-in task as ready', async () => {
  const rpc = async method =>
    method === 'todos.bindings' ? [{ task_id: 'native-task' }] : { task: { status: 'failed' } }
  await assert.rejects(waitForLocalStandInTask(rpc, { id: 'issue' }, 1000), /failed/)
})
