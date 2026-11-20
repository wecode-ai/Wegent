import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

const outputs = new Map()
const intentionallyClosedSources = new WeakSet()

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
      sources: new Map(),
      sourceCompletions: [],
    }
    const sources = output.sources
    output.writer.on('error', error => {
      for (const source of sources.keys()) source.destroy(error)
    })
    outputs.set(destination, output)
  }
  return output
}

export function appendProcessOutput(stream, destination, owner) {
  if (!stream) return
  const output = outputFor(destination)
  output.sources.set(stream, owner)
  output.sourceCompletions.push(
    completionOf(stream, { readable: true, writable: false }).then(result => {
      if (
        intentionallyClosedSources.has(stream) &&
        result.status === 'rejected' &&
        result.reason.code === 'ERR_STREAM_PREMATURE_CLOSE'
      ) {
        return { status: 'fulfilled' }
      }
      return result
    })
  )
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

// A Windows release handoff can keep inherited pipes open after their launcher exits.
export async function closeExitedProcessOutput(destination) {
  const output = outputs.get(destination)
  if (!output) return
  while (output.writer.writableNeedDrain) await once(output.writer, 'drain')
  for (const [source, owner] of output.sources) {
    if (owner?.exitCode == null && owner?.signalCode == null) continue
    intentionallyClosedSources.add(source)
    source.destroy()
  }
}

function reportPendingOutput() {
  console.error(
    '[desktop-e2e-process-output]',
    JSON.stringify({
      pending: [...outputs].map(([destination, output]) => ({
        destination,
        writer: {
          pendingBytes: output.writer.writableLength,
          ended: output.writer.writableEnded,
          finished: output.writer.writableFinished,
          closed: output.writer.closed,
          destroyed: output.writer.destroyed,
        },
        sources: [...output.sources].map(([source, owner]) => ({
          pid: owner?.pid,
          exitCode: owner?.exitCode,
          signalCode: owner?.signalCode,
          pendingBytes: source.readableLength,
          ended: source.readableEnded,
          closed: source.closed,
          destroyed: source.destroyed,
          paused: source.isPaused(),
        })),
      })),
    })
  )
}

export async function flushProcessOutput() {
  const diagnostic = setInterval(reportPendingOutput, 10_000)
  diagnostic.unref()
  try {
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
  } finally {
    clearInterval(diagnostic)
  }
}
