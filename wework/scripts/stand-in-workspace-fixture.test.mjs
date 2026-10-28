import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-workspace.scenario.mjs'

const PARTIAL_OUTPUT = 'AUTHORIZED_NETWORK_READSOURCE_PLUGIN_RESOURCE_READABLE'
const REMAINING_OUTPUT = 'SOURCE_GH_CONFIG_READABLESOURCE_OUTSIDE_WRITE_BLOCKED'
const output = (callId, text) => ({ type: 'function_call_output', call_id: callId, output: text })

async function withScenario(run) {
  const root = await mkdtemp(join(tmpdir(), 'stand-in-workspace-fixture-'))
  try {
    await run(
      createDesktopScenario({
        workspacePath: join(root, 'workspace'),
        homePath: join(root, 'home'),
      })
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
  await withScenario(async scenario => {
    const inputs = [
      output('source-sandbox-probe', `Process running with session ID 71687\n${PARTIAL_OUTPUT}`),
      output('source-sandbox-probe-poll-1', 'Process running with session ID 71687\n'),
    ]
    const [poll] = await respond(scenario, inputs)
    assert.equal(poll.call_id, 'source-sandbox-probe-poll-2')

    inputs.push(
      output('source-sandbox-probe-poll-2', `Process exited with code 0\n${REMAINING_OUTPUT}`)
    )
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
  ['unauthorized write', `${PARTIAL_OUTPUT}${REMAINING_OUTPUT}SOURCE_OUTSIDE_WRITE_ALLOWED`],
  ['terminated command', 'Process exited with code 143\nOutput:\n'],
])('rejects terminal sandbox evidence with %s', async (_label, text) => {
  await withScenario(async scenario => {
    await assert.rejects(respond(scenario, [output('source-sandbox-probe-poll-1', text)]))
  })
})

test('a completed private-read review still requires denial without leaking private data', async () => {
  await withScenario(async scenario => {
    scenario.reviewApproval({ input: ['Read the bound context'] })
    scenario.reviewApproval({ input: ['REVIEW_PRIVATE_READ'] })
    const [message] = await respond(scenario, [
      output('source-private-review-poll-1', 'The private read was denied'),
    ])
    assert.equal(message.type, 'message')
    await assert.rejects(
      respond(scenario, [
        output('source-private-review-poll-1', 'denied SYNTHETIC_SOURCE_PRIVATE_DATA'),
      ])
    )
  })
})
