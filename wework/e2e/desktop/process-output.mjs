import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

const outputs = new Map()

function completionOf(stream, options = {}) {
  return finished(stream, { cleanup: true, ...options }).then(
    () => ({ status: 'fulfilled' }),
    reason => ({ status: 'rejected', reason })
  )
}

function outputFor(destination) {
  let output = outputs.get(destination)
  if (!output) {
    const writer = createWriteStream(destination, { flags: 'a' })
    output = {
      writer,
      written: completionOf(writer),
      sources: new Set(),
      sourceCompletions: [],
    }
    const sources = output.sources
    output.writer.on('error', error => {
      for (const source of sources) source.destroy(error)
    })
    outputs.set(destination, output)
  }
  return output
}

export function appendProcessOutput(stream, destination) {
  if (!stream) return
  const output = outputFor(destination)
  output.sources.add(stream)
  output.sourceCompletions.push(completionOf(stream, { readable: true, writable: false }))
  const complete = () => output.sources.delete(stream)
  stream.once('end', complete)
  stream.once('close', complete)
  stream.on('data', chunk => {
    // A single writer preserves stdout/stderr order without blocking the model server.
    if (!output.writer.write(chunk)) {
      stream.pause()
      output.writer.once('drain', () => stream.resume())
    }
  })
}

export async function flushProcessOutput() {
  const results = await Promise.allSettled(
    [...outputs].map(async ([destination, output]) => {
      try {
        const [written, sources] = await Promise.all([
          output.written,
          Promise.all(output.sourceCompletions).then(results => {
            output.writer.end()
            return results
          }),
        ])
        if (written.status === 'rejected') throw written.reason
        const failures = sources.filter(result => result.status === 'rejected')
        if (failures.length) {
          throw new AggregateError(
            failures.map(result => result.reason),
            'Process output did not finish cleanly'
          )
        }
      } finally {
        outputs.delete(destination)
      }
    })
  )
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) {
    throw new AggregateError(
      failures.map(result => result.reason),
      'Process log drainage failed'
    )
  }
}
