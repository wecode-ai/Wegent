import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

const outputs = new Map()

function outputFor(destination) {
  let output = outputs.get(destination)
  if (!output) {
    output = { writer: createWriteStream(destination, { flags: 'a' }), sources: new Set() }
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
        const sources = Promise.allSettled(
          [...output.sources].map(source =>
            finished(source, { cleanup: true, readable: true, writable: false })
          )
        )
        const written = finished(output.writer, { cleanup: true })
        await Promise.all([
          written,
          sources.then(results => {
            output.writer.end()
            const failures = results.filter(result => result.status === 'rejected')
            if (failures.length) {
              throw new AggregateError(
                failures.map(result => result.reason),
                'Process output did not finish cleanly'
              )
            }
          }),
        ])
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
