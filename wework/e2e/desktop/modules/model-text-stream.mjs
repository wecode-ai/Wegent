import { createSse, streamingTextEvents } from './response-protocol.mjs'

const data = value => `data: ${JSON.stringify(value)}\n\n`
const event = value => `event: ${value.type}\n${data(value)}`

/** Share text framing between complete replies and deliberately paced fixture streams. */
export function modelTextStream(protocol, id, text, chunks, { phase = 'final_answer' } = {}) {
  const stream = streamingTextEvents(id, text, phase)
  const deltas = chunks ?? stream.chunks
  if (protocol === 'responses') {
    let offset = 0
    return {
      start: createSse(stream.start),
      chunks: deltas.map(delta => {
        const frame = createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta,
            offset,
          },
        ])
        offset += [...delta].length
        return frame
      }),
      finish: createSse(stream.finish),
      finishContent: createSse(stream.finish.filter(event => event.type !== 'response.completed')),
    }
  }
  if (protocol === 'chat') {
    const chunk = (delta, finish_reason = null) =>
      data({
        id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }],
      })
    return {
      start: '',
      chunks: deltas.map((content, index) =>
        chunk({ ...(index === 0 ? { role: 'assistant' } : {}), content })
      ),
      finish: chunk({}, 'stop') + 'data: [DONE]\n\n',
      finishContent: '',
    }
  }
  if (protocol !== 'anthropic') throw new Error(`Unsupported model text protocol: ${protocol}`)
  return {
    start:
      event({
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'desktop-e2e-anthropic-model',
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }) +
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunks: deltas.map(text =>
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
    ),
    finish:
      event({ type: 'content_block_stop', index: 0 }) +
      event({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: text ? 1 : 0 },
      }) +
      event({ type: 'message_stop' }),
    finishContent: event({ type: 'content_block_stop', index: 0 }),
  }
}
