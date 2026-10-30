import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'vitest'
import { createBoardReplyModelRegression } from '../e2e/desktop/modules/board-reply-model.mjs'
import { REPLY_PREDICTION_PROMPT } from '../e2e/desktop/modules/response-protocol.mjs'

function requestFor(text) {
  const request = Readable.from([JSON.stringify({ input: [{ role: 'user', content: text }] })])
  request.method = 'POST'
  return request
}

function response() {
  return {
    output: '',
    ended: false,
    writeHead(status) {
      assert.equal(status, 200)
    },
    write(chunk) {
      this.output += chunk
    },
    end(chunk) {
      this.output += chunk
      this.ended = true
    },
  }
}

test('holds the Issue-bound local task with its own prompt instead of the initial-task fixture', async () => {
  const model = createBoardReplyModelRegression({ executorHome: '/tmp/unused', uiTimeoutMs: 100 })
  const task = model.holdLinkedIssueTask('space', { id: 'ISSUE-1', title: 'Issue title' })
  const result = response()
  const pending = model.handleHttp(
    requestFor('[projectSpaceIssue] Issue title wework-issue://space/ISSUE-1'),
    result,
    new URL('http://fixture/v1/responses')
  )
  await setImmediate()
  assert.equal(task.requests.length, 1)
  assert.equal(result.ended, false)
  assert.match(result.output, /response.created/)
  task.release()
  assert.equal(await pending, true)
  assert.equal(result.ended, true)
  assert.match(result.output, /COLLABORATION_LINKED_ISSUE_TASK_COMPLETE/)
})

test('does not count predictions as Issue task requests and rejects missing Issue context', async () => {
  const model = createBoardReplyModelRegression({ executorHome: '/tmp/unused', uiTimeoutMs: 100 })
  const task = model.holdLinkedIssueTask('space', { id: 'ISSUE-1', title: 'Issue title' })
  const url = new URL('http://fixture/responses')
  assert.equal(await model.handleHttp(requestFor(REPLY_PREDICTION_PROMPT), response(), url), true)
  assert.equal(task.requests.length, 0)
  await assert.rejects(
    model.handleHttp(requestFor('Unrelated task'), response(), url),
    /lost its Issue context/
  )
  task.release()
})
