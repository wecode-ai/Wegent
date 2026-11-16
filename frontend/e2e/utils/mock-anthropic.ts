import type * as http from 'http'

type AnthropicInputUsage = { input_tokens: number; cache_read_input_tokens?: number }

export function writeAnthropicSseEvent(
  res: http.ServerResponse,
  event: string,
  data: unknown
): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function writeAnthropicStreamingResponse(
  res: http.ServerResponse,
  content: string,
  model: string,
  chunkDelayMs: number,
  doneDelayMs: number,
  inputUsage: AnthropicInputUsage = { input_tokens: 100 }
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  writeAnthropicSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        ...inputUsage,
        output_tokens: 0,
      },
    },
  })
  writeAnthropicSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'text',
      text: '',
    },
  })

  const chunks = content.split(' ')
  let index = 0

  const sendChunk = () => {
    if (index < chunks.length) {
      const text = index === 0 ? chunks[index] : ' ' + chunks[index]
      writeAnthropicSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      })
      index++
      setTimeout(sendChunk, chunkDelayMs)
      return
    }

    setTimeout(() => {
      writeAnthropicSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      })
      writeAnthropicSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: Math.max(1, chunks.length),
        },
      })
      writeAnthropicSseEvent(res, 'message_stop', {
        type: 'message_stop',
      })
      res.end()
    }, doneDelayMs)
  }

  sendChunk()
}

export function writeAnthropicJsonResponse(
  res: http.ServerResponse,
  content: string,
  model: string,
  inputUsage: AnthropicInputUsage = { input_tokens: 100 }
): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        ...inputUsage,
        output_tokens: Math.max(1, content.split(' ').length),
      },
    })
  )
}
