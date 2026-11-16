import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

export class JsonLineReader extends EventEmitter<{
  line: [string]
  overflow: []
}> {
  constructor(input: Readable, maxFrameBytes: number)
  close(): void
}
