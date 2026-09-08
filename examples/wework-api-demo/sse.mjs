// Parse SSE independently of HTTP chunk boundaries, including CRLF and comments.
export function createSSEParser(onEvent, onHeartbeat = () => {}) {
  let buffer = ''
  let event = ''
  let data = []
  const line = (value) => {
    if (value === '') {
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n') })
      event = ''
      data = []
      return
    }
    if (value.startsWith(':')) return onHeartbeat()
    const colon = value.indexOf(':')
    const name = colon < 0 ? value : value.slice(0, colon)
    const text = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (name === 'event') event = text
    if (name === 'data') data.push(text)
  }
  return {
    feed(chunk) {
      buffer += chunk
      while (true) {
        const index = buffer.search(/[\r\n]/)
        if (index < 0 || (buffer[index] === '\r' && index === buffer.length - 1)) break
        const length = buffer.slice(index, index + 2) === '\r\n' ? 2 : 1
        line(buffer.slice(0, index))
        buffer = buffer.slice(index + length)
      }
    },
    finish() {
      if (buffer === '\r') line('')
      // An event without a blank-line terminator is incomplete and is discarded.
      buffer = ''
      data = []
      event = ''
    },
  }
}
