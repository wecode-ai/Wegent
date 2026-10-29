import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-workspace.scenario.mjs'

const PARTIAL_OUTPUT = 'AUTHORIZED_NETWORK_READSOURCE_PLUGIN_RESOURCE_READABLE'
const hasOsSandbox = process.platform !== 'win32'
const outsideWriteMarker = hasOsSandbox
  ? 'SOURCE_OUTSIDE_WRITE_BLOCKED'
  : 'SOURCE_OUTSIDE_WRITE_ALLOWED'
const contradictoryWriteMarker = hasOsSandbox
  ? 'SOURCE_OUTSIDE_WRITE_ALLOWED'
  : 'SOURCE_OUTSIDE_WRITE_BLOCKED'
const REMAINING_OUTPUT = `SOURCE_GH_CONFIG_READABLE${outsideWriteMarker}`
const output = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: text })

async function withScenario(run) {
  const root = await mkdtemp(join(tmpdir(), 'stand-in-workspace-fixture-'))
  try {
    await run(
      createDesktopScenario({
        workspacePath: join(root, 'workspace'),
        homePath: join(root, 'home'),
      }),
      root
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function respond(scenario, outputs) {
  const request = Readable.from([
    JSON.stringify({
      input: [{ role: 'user', content: `STAND_IN_WORKSPACE_${process.pid}` }, ...outputs],
      tools: [{ name: 'exec_command' }, { name: 'write_stdin' }],
    }),
  ])
  request.method = 'POST'
  let payload
  const response = {
    writeHead(status) {
      assert.equal(status, 200)
    },
    end(value) {
      payload = value
    },
  }
  assert.equal(
    await scenario.handleHttp(request, response, new URL('http://fixture/v1/responses')),
    true
  )
  return payload
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
    .filter(event => event.type === 'response.output_item.done')
    .map(event => event.item)
}

test.each([
  'source-sandbox-probe',
  'source-approved-escalation',
  'source-escalation-not-persistent',
  'source-private-review',
])('polls the running %s command before checking partial output', async callId => {
  await withScenario(async scenario => {
    const [poll] = await respond(scenario, [
      output(callId, `Process running with session ID 71687\nOutput:\n${PARTIAL_OUTPUT}`),
    ])

    assert.equal(poll.name, 'write_stdin')
    assert.equal(poll.call_id, `${callId}-poll-1`)
    assert.deepEqual(JSON.parse(poll.arguments), {
      session_id: 71687,
      chars: '',
      yield_time_ms: 1000,
    })
  })
})

test('checks complete sandbox evidence across yielded chunks before requesting explicit escalation', async () => {
  await withScenario(async (scenario, root) => {
    const inputs = [
      output('source-sandbox-probe', `Process running with session ID 71687\n${PARTIAL_OUTPUT}`),
      output('source-sandbox-probe-poll-1', 'Process running with session ID 71687\n'),
    ]
    const [poll] = await respond(scenario, inputs)
    assert.equal(poll.call_id, 'source-sandbox-probe-poll-2')

    inputs.push(
      output('source-sandbox-probe-poll-2', `Process exited with code 0\n${REMAINING_OUTPUT}`)
    )
    if (!hasOsSandbox) await writeFile(join(root, 'source-approved-proof.txt'), 'unapproved')
    const [escalation] = await respond(scenario, inputs)
    assert.equal(escalation.call_id, 'source-approved-escalation')
    const args = JSON.parse(escalation.arguments)
    assert.equal(args.sandbox_permissions, 'require_escalated')
    assert.equal(
      args.justification,
      'Create the explicitly authorized regression proof outside the workspace.'
    )
    assert.ok(args.cmd.includes('SOURCE_ESCALATION_SUCCEEDED'))
  })
})

test.each([
  ['missing marker', PARTIAL_OUTPUT],
  [
    'contradictory source write result',
    `${PARTIAL_OUTPUT}${REMAINING_OUTPUT}${contradictoryWriteMarker}`,
  ],
  ['terminated command', 'Process exited with code 143\nOutput:\n'],
])('rejects terminal sandbox evidence with %s', async (_label, text) => {
  await withScenario(async scenario => {
    await assert.rejects(respond(scenario, [output('source-sandbox-probe-poll-1', text)]), {
      code: 'ERR_ASSERTION',
      message: text,
    })
  })
})

test.each(['function_call_output', 'custom_tool_call_output'])(
  'a completed %s private-read review requires denial without leaking private data',
  async type => {
    await withScenario(async scenario => {
      scenario.reviewApproval({ input: ['Read the bound context'] })
      scenario.reviewApproval({ input: ['REVIEW_PRIVATE_READ'] })
      const [message] = await respond(scenario, [
        { ...output('source-private-review-poll-1', 'The private read was denied'), type },
      ])
      assert.equal(message.type, 'message')
      await assert.rejects(
        respond(scenario, [
          {
            ...output('source-private-review-poll-1', 'denied SYNTHETIC_SOURCE_PRIVATE_DATA'),
            type,
          },
        ]),
        { code: 'ERR_ASSERTION', message: 'The denied private read leaked source data' }
      )
    })
  }
)

test.each([
  [
    'approved context read',
    'REVIEW_PRIVATE_READ',
    'The native reviewer must approve the context read',
  ],
  [
    'denied private read',
    'Read the bound context',
    'The native reviewer must deny the private read',
  ],
])(
  'rejects completed private output without an independent %s',
  async (_label, review, message) => {
    await withScenario(async scenario => {
      scenario.reviewApproval({ input: [review] })
      await assert.rejects(
        respond(scenario, [output('source-private-review-poll-1', 'The private read was denied')]),
        { code: 'ERR_ASSERTION', message }
      )
    })
  }
)

test('completed sandbox polling evidence advances without the original response', async () => {
  await withScenario(async (scenario, root) => {
    if (!hasOsSandbox) await writeFile(join(root, 'source-approved-proof.txt'), 'unapproved')
    const [escalation] = await respond(scenario, [
      output('source-sandbox-probe-poll-1', `${PARTIAL_OUTPUT}${REMAINING_OUTPUT}`),
    ])
    assert.equal(escalation.call_id, 'source-approved-escalation')
    assert.equal(JSON.parse(escalation.arguments).sandbox_permissions, 'require_escalated')
  })
})

test('completed approved-escalation polling advances after checking the real proof file', async () => {
  await withScenario(async (scenario, root) => {
    await writeFile(join(root, 'source-approved-proof.txt'), 'approved-escalation')
    const [next] = await respond(scenario, [
      output('source-approved-escalation-poll-1', 'SOURCE_ESCALATION_SUCCEEDED'),
    ])
    assert.equal(next.call_id, 'source-escalation-not-persistent')
    assert.ok(JSON.parse(next.arguments).cmd.includes('SOURCE_OUTSIDE_WRITE_'))
  })
})

test('completed nonpersistent-escalation polling retains the private-read approval boundary', async () => {
  await withScenario(async (scenario, root) => {
    await writeFile(
      join(root, 'source-approved-proof.txt'),
      hasOsSandbox ? 'approved-escalation' : 'approved-escalationunapproved'
    )
    const [review] = await respond(scenario, [
      output('source-escalation-not-persistent-poll-1', outsideWriteMarker),
    ])
    assert.equal(review.call_id, 'source-private-review')
    const args = JSON.parse(review.arguments)
    assert.equal(args.sandbox_permissions, 'require_escalated')
    assert.equal(
      args.justification,
      'REVIEW_PRIVATE_READ: source requests an unrelated private file'
    )
  })
})

test('a first request still requires the advertised MCP discovery protocol', async () => {
  await withScenario(async scenario => {
    await assert.rejects(respond(scenario, []), {
      code: 'ERR_ASSERTION',
      message:
        /^Real Codex did not advertise exactly one deferred tool search: exec_command, write_stdin/,
    })
  })
})
