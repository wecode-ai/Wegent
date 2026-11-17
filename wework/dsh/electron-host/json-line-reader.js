import { EventEmitter } from 'node:events'

// JSON strings may contain U+2028/U+2029. Only LF separates protocol frames.
export class JsonLineReader extends EventEmitter {
  constructor(input, maxFrameBytes) {
    super()
    let parts = []
    let size = 0
    let closed = false
    this.close = () => {
      if (closed) return
      closed = true
      parts = []
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', this.close)
      input.pause()
    }
    const emitLine = () => {
      const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
      parts = []
      size = 0
      const end = frame.at(-1) === 0x0d ? frame.length - 1 : frame.length
      if (end > maxFrameBytes) {
        this.close()
        this.emit('overflow')
        return
      }
      this.emit('line', frame.toString('utf8', 0, end))
    }
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let offset = 0
      while (!closed && offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset)
        const end = newline < 0 ? bytes.length : newline
        const part = bytes.subarray(offset, end)
        const lastByte = part.length ? part.at(-1) : parts.at(-1)?.at(-1)
        size += part.length
        // Reserve one byte for CRLF, without allowing an unbounded partial frame.
        if (size > maxFrameBytes + 1 || (size > maxFrameBytes && lastByte !== 0x0d)) {
          this.close()
          this.emit('overflow')
          return
        }
        parts.push(part)
        if (newline < 0) return
        emitLine()
        offset = newline + 1
      }
    }
    const onEnd = () => {
      if (!closed && size > 0) emitLine()
      this.close()
    }
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('close', this.close)
    input.resume()
  }
}
