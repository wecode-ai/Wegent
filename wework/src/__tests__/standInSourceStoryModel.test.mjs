// @vitest-environment node
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createSourceStoryModel } from '../../e2e/desktop/modules/stand-in-source-story-model.mjs'

const MARKER = 'SOURCE_MODEL_GUARD'
const expected = phase => ({
  text: `source fact ${phase}`,
  fact: `verified finding ${phase}`,
  version: `v${phase}`,
  messageId: `message-${phase}`,
  reply: `reply ${phase}`,
})
const output = (callId, value) => ({
  type: 'function_call_output',
  call_id: callId,
  output: [{ type: 'input_text', text: JSON.stringify(value) }],
})
const tools = [
  'read_work',
  'read_task',
  'read_intake',
  'continue_work',
  'reply',
  'get_profile',
  'propose_profile',
].map(name => ({
  type: 'function',
  name: `mcp__wework_stand_in__${name}`,
  parameters: { type: 'object' },
}))

function fixture(mode = 'project') {
  const model = createSourceStoryModel({
    marker: MARKER,
    roleId: 'role',
    providerId: 'provider',
    mode,
    expected,
  })
  model.active = true
  return model
}

async function request(model, outputs = [], text = `New events: ${MARKER}`) {
  const body = { tools, input: [{ role: 'user', content: text }, ...outputs] }
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  let response = ''
  const handled = await model.handleHttp(
    req,
    {
      writeHead() {},
      end(value) {
        response = value
      },
    },
    new URL('http://localhost/responses')
  )
  return {
    handled,
    response,
    events: response
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6))),
  }
}

function sourceRead(phase = 1) {
  return output(`${MARKER}-work-${phase}`, {
    work: { taskId: 'actual-task' },
    messages: [{ id: `message-${phase}`, recordId: `record-${phase}`, text: expected(phase).text }],
  })
}

describe('source story model evidence guards', () => {
  it('cannot produce an outcome before the real bounded original-event read', async () => {
    const model = fixture()
    const first = await request(model)
    expect(first.response).toContain('mcp__wework_stand_in__read_work')
    expect(first.response).not.toContain(expected(1).fact)
    const summary = await request(model, [sourceRead()])
    expect(summary.response).toContain('payloadOffset')
    expect(summary.response).toContain('record-1')
    expect(summary.response).not.toContain(expected(1).fact)
    const complete = await request(model, [
      sourceRead(),
      output(`${MARKER}-work-1-payload`, {
        payload: JSON.stringify({
          id: 'message-1',
          recordId: 'record-1',
          text: expected(1).text,
          version: 'v1',
        }),
        nextOffset: null,
      }),
    ])
    expect(complete.response).toContain(expected(1).fact)
    expect(model.reads).toEqual([
      { phase: 1, taskId: 'actual-task', recordId: 'record-1', messageId: 'message-1' },
    ])
  })

  it.each([
    { text: 'different fact', version: 'v1', nextOffset: null },
    { text: expected(1).text, version: 'different version', nextOffset: null },
    { text: expected(1).text, version: 'v1', nextOffset: 12000 },
    { text: expected(1).text, version: 'v1', recordId: 'different-record', nextOffset: null },
  ])('rejects substituted or incomplete source evidence (%j)', async value => {
    await expect(
      request(fixture(), [
        sourceRead(),
        output(`${MARKER}-work-1-payload`, {
          payload: JSON.stringify({
            recordId: value.recordId ?? 'record-1',
            text: value.text,
            version: value.version,
          }),
          nextOffset: value.nextOffset,
        }),
      ])
    ).rejects.toThrow()
  })

  it('cannot report a reply without a successful native protocol receipt', async () => {
    const model = fixture('reply')
    await request(model, [
      sourceRead(),
      output(`${MARKER}-work-1-payload`, {
        payload: JSON.stringify({ id: 'message-1', recordId: 'record-1', text: expected(1).text }),
        nextOffset: null,
      }),
    ])
    await expect(
      request(model, [output(`${MARKER}-work-1-reply`, { success: false })])
    ).rejects.toThrow()
    await expect(
      request(model, [output(`${MARKER}-work-1-reply`, { success: true })])
    ).rejects.toThrow()
    const accepted = await request(model, [
      output(`${MARKER}-work-1-reply`, {
        success: true,
        result: { openMessageId: 'native-receipt' },
      }),
    ])
    expect(accepted.response).toContain(expected(1).fact)
    expect(model.replies).toEqual([{ phase: 1, receipt: 'native-receipt' }])
  })

  it("cannot pretend a native failure was the verifier's cancellation", async () => {
    const model = fixture('reply')
    model.phase = 2
    await request(model, [
      sourceRead(2),
      output(`${MARKER}-work-2-payload`, {
        payload: JSON.stringify({ id: 'message-2', recordId: 'record-2', text: expected(2).text }),
        nextOffset: null,
      }),
    ])
    await expect(
      request(model, [output(`${MARKER}-work-2-reply`, { error: 'denied' })])
    ).rejects.toThrow()
  })

  it('requires the current immutable inventory before continuing the original work', async () => {
    const model = fixture()
    model.taskId = 'actual-task'
    model.phase = 2
    await expect(
      request(
        model,
        [
          output(`${MARKER}-intake-0-read`, {
            snapshot: {
              events: [{ id: 'event-v2', kind: 'connection', roleIds: ['role'], text: MARKER }],
              works: [],
            },
          }),
        ],
        'Review this silent intake batch'
      )
    ).rejects.toThrow()
  })

  it('does not become an automatic grant merely by proposing one', async () => {
    const model = fixture('reply')
    const result = await request(
      model,
      [
        output(`${MARKER}-profile`, {
          version: 42,
          roles: [
            {
              id: 'role',
              connections: [{ providerId: 'provider', policy: { askBeforeAct: true } }],
            },
          ],
        }),
      ],
      `${MARKER}-CONTINUOUS`
    )
    const event = result.events.find(
      item => item.type === 'response.output_item.done' && item.item?.type === 'function_call'
    )
    expect(event.item.name).toBe('mcp__wework_stand_in__propose_profile')
    expect(JSON.parse(event.item.arguments).settings.version).toBe(42)
    expect(model.continuous).toBe(false)
    expect(model.proposalSubmitted).toBe(false)
  })
})
