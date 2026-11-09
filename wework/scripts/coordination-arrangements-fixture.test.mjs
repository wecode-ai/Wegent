// @vitest-environment node

import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/coordination-arrangements.scenario.mjs'

test('an arrangement result wake reads the actual child instead of replaying historic work', async () => {
  const request = Readable.from([
    JSON.stringify({
      input: [
        { role: 'user', content: 'ARRANGEMENT_RECOVERY_NATIVE_WORK_once' },
        {
          role: 'user',
          content:
            'Wework delegated task result: resultId=stand-in-result:one, taskId=arrangement-child, status=done, errorCode=null',
        },
      ],
      tools: [{ type: 'tool_search' }],
    }),
  ])
  request.method = 'POST'
  let output
  const handled = await createDesktopScenario({ executorHome: '/test-executor-home' }).handleHttp(
    request,
    {
      writeHead() {},
      end(value) {
        output = value
      },
    },
    new URL('http://localhost/v1/responses')
  )
  expect(handled).toBe(true)
  expect(output).toContain('read_task')
  expect(output).not.toContain('已完成安排的工作。')
})
