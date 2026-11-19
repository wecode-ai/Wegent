import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { basename } from 'node:path'
import { PROCESS_STOP_TIMEOUT_MS } from './process-lifecycle.mjs'

const outputs = new Map()
const owners = new WeakMap()
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
      sources: new Set(),
      sourceCompletions: [],
      allSources: [],
    }
    const sources = output.sources
    output.writer.on('error', error => {
      for (const source of sources) source.destroy(error)
    })
    outputs.set(destination, output)
  }
  return output
}

export function appendChildProcessOutput(child, destination) {
  for (const stream of [child.stdout, child.stderr]) appendProcessOutput(stream, destination, child)
}

export function appendProcessOutput(stream, destination, owner) {
  if (!stream) return
  if (owner) owners.set(stream, owner)
  const output = outputFor(destination)
  output.sources.add(stream)
  output.allSources.push(stream)
  output.sourceCompletions.push(
    completionOf(stream, { readable: true, writable: false }).then(result => {
      if (
        intentionallyClosedSources.has(stream) &&
        result.status === 'rejected' &&
        result.reason.code === 'ERR_STREAM_PREMATURE_CLOSE'
      )
        return { status: 'fulfilled' }
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

// Only release handoff pipes may be closed after their launcher has exited.
export async function closeExitedProcessOutput(destination) {
  const output = outputs.get(destination)
  if (!output) return
  while (output.writer.writableNeedDrain) await once(output.writer, 'drain')
  for (const source of output.sources) {
    const owner = owners.get(source)
    if (owner?.exitCode == null && owner?.signalCode == null) continue
    if (source.readableLength > 0)
      throw new Error('Exited launcher output still contains unread bytes')
    intentionallyClosedSources.add(source)
    source.destroy()
  }
}

/** Lifecycle state only: never retain output contents, arguments, or environment. */
export function processOutputDiagnostics() {
  return [...outputs].map(([destination, output]) => ({
    destination: basename(destination),
    writer: {
      pending: output.writer.pending,
      closed: output.writer.closed,
      destroyed: output.writer.destroyed,
      finished: output.writer.writableFinished,
      bufferedBytes: output.writer.writableLength,
      needsDrain: output.writer.writableNeedDrain,
    },
    sources: output.allSources.map(stream => ({
      owner: owners.has(stream)
        ? {
            pid: owners.get(stream).pid,
            exitCode: owners.get(stream).exitCode,
            signalCode: owners.get(stream).signalCode,
          }
        : null,
      ended: stream.readableEnded,
      closed: stream.closed,
      destroyed: stream.destroyed,
      paused: stream.isPaused(),
      bufferedBytes: stream.readableLength,
    })),
  }))
}

async function finishSources(output, destination, timeoutMs) {
  let timeout
  const completion = Promise.all(output.sourceCompletions)
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(
        `Process output sources did not close after shutdown: ${basename(destination)}`
      )
      error.code = 'ERR_PROCESS_OUTPUT_UNCLOSED'
      reject(error)
      // An incomplete log remains a failure; closing our readers only releases the collector.
      for (const source of output.sources) source.destroy(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([completion, deadline])
  } finally {
    clearTimeout(timeout)
    await completion
    output.writer.end()
  }
}

export async function flushProcessOutput({ sourceTimeoutMs = PROCESS_STOP_TIMEOUT_MS } = {}) {
  const results = await Promise.allSettled(
    [...outputs].map(async ([destination, output]) => {
      try {
        const [writtenResult, sourcesResult] = await Promise.allSettled([
          output.written,
          finishSources(output, destination, sourceTimeoutMs),
        ])
        if (writtenResult.status === 'rejected') throw writtenResult.reason
        const written = writtenResult.value
        if (written.status === 'rejected') throw written.reason
        if (sourcesResult.status === 'rejected') throw sourcesResult.reason
        const sources = sourcesResult.value
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
