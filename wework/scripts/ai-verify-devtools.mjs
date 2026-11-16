import { readFile, readdir, writeFile, mkdir, chmod, realpath, rm } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceMap } from 'node:module'

const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url))

export async function createDevtoolsClient(directory, timeoutMs = 30_000) {
  const registry = join(directory, 'desktop-control')
  const files = (await readdir(registry)).filter(name => name.endsWith('.json'))
  if (files.length !== 1) throw new Error('Expected exactly one isolated desktop control instance')
  const record = JSON.parse(await readFile(join(registry, files[0]), 'utf8'))
  if (!/^127\.0\.0\.1:\d+$/.test(record.address))
    throw new Error('DevTools requires loopback transport')
  return async input => {
    const response = await fetch(`http://${record.address}/devtools`, {
      method: 'POST',
      headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json()
    if (!response.ok || !body.ok) throw new Error(body.error ?? `DevTools HTTP ${response.status}`)
    if (input.action === 'detach' && Number.isInteger(input.target)) {
      await rm(join(directory, `performance-${input.target}.json`), { force: true })
    }
    return body.data
  }
}

export async function writeDiagnosticFile(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readLocalSourceMap(url, root = repositoryDirectory) {
  const path = await realpath(fileURLToPath(url))
  const within = relative(await realpath(root), path)
  if (within.startsWith('..') || isAbsolute(within) || !path.endsWith('.map')) {
    throw new Error('Local source maps must be .map files inside the verification repository')
  }
  return readFile(path, 'utf8')
}

export async function readProtocolStream(command, handle) {
  const chunks = []
  try {
    for (;;) {
      const part = await command('IO.read', { handle, size: 1024 * 1024 })
      chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'))
      if (part.eof) return Buffer.concat(chunks).toString('utf8')
    }
  } finally {
    await command('IO.close', { handle })
  }
}

export async function collectProtocolEvents(client, target, after = 0) {
  const events = []
  let lost = 0
  for (;;) {
    const page = await client({ action: 'events', target, after, limit: 1000 })
    events.push(...page.events)
    lost += page.lost
    after = page.next
    if (after >= page.latest) return { events, lost, cursor: after, attached: page.attached }
  }
}

export async function startPerformanceRecording(client, directory, target) {
  const statePath = join(directory, `performance-${target}.json`)
  try {
    await readFile(statePath)
    throw new Error('A recording already exists for this target; stop it first')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const command = (method, params) => client({ action: 'command', target, method, params })
  const initial = await collectProtocolEvents(client, target)
  let profiling = false
  let tracing = false
  try {
    for (const domain of ['Runtime', 'Log', 'Network', 'Debugger', 'Performance', 'Profiler']) {
      await command(`${domain}.enable`)
    }
    const baseline = await command('Performance.getMetrics')
    await command('Profiler.start')
    profiling = true
    await command('Tracing.start', {
      categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',
      transferMode: 'ReturnAsStream',
    })
    tracing = true
    await writeDiagnosticFile(statePath, {
      target,
      after: initial.cursor,
      metadata: initial.events.filter(event =>
        ['Debugger.scriptParsed', 'Runtime.executionContextCreated'].includes(event.method)
      ),
      metadataLostEvents: initial.lost,
      baseline,
      startedAt: Date.now(),
    })
    return { target, recording: true, statePath }
  } catch (error) {
    if (tracing) await command('Tracing.end').catch(() => {})
    if (profiling) await command('Profiler.stop').catch(() => {})
    throw error
  }
}

async function loadSourceMaps(command, events, profile) {
  const usedScripts = new Set(profile.nodes.map(node => node.callFrame.scriptId))
  const frames = new Map(
    events
      .filter(event => event.method === 'Runtime.executionContextCreated')
      .map(event => [event.params.context.id, event.params.context.auxData?.frameId])
  )
  const scripts = new Map()
  const maps = new Map()
  const errors = []
  for (const event of events) {
    if (event.method === 'Debugger.scriptParsed') scripts.set(event.params.scriptId, event.params)
  }
  for (const script of scripts.values()) {
    if (!usedScripts.has(script.scriptId) || !script.sourceMapURL || !script.url) continue
    try {
      const url = new URL(script.sourceMapURL, script.url)
      let text
      if (url.protocol === 'data:') {
        const comma = url.href.indexOf(',')
        text = /;base64,/.test(url.href)
          ? Buffer.from(url.href.slice(comma + 1), 'base64').toString('utf8')
          : decodeURIComponent(url.href.slice(comma + 1))
      } else if (url.protocol === 'file:') {
        text = await readLocalSourceMap(url)
      } else {
        const { resource } = await command('Network.loadNetworkResource', {
          frameId: frames.get(script.executionContextId),
          url: url.href,
          options: { disableCache: false, includeCredentials: false },
        })
        if (!resource.success || !resource.stream)
          throw new Error(`Source map HTTP ${resource.httpStatusCode}`)
        text = await readProtocolStream(command, resource.stream)
      }
      maps.set(script.scriptId, { map: new SourceMap(JSON.parse(text)), url: url.href })
    } catch (error) {
      errors.push({ scriptId: script.scriptId, url: script.url, error: error.message })
    }
  }
  return { maps, errors }
}

export function sourceLocation(frame, maps = new Map()) {
  const generated = { url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1 }
  const entry = maps.get(frame.scriptId)
  if (!entry) return { generated, mapped: false }
  const original = entry.map.findEntry(frame.lineNumber, frame.columnNumber)
  if (!original.originalSource) return { generated, mapped: false }
  const url = new URL(original.originalSource, entry.url)
  return {
    generated,
    mapped: true,
    source: url.protocol === 'file:' ? fileURLToPath(url) : url.href,
    line: original.originalLine + 1,
    column: original.originalColumn + 1,
    name: original.name,
  }
}

export function analyzeCpuProfile(profile, maps) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id)
  const costs = new Map()
  for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
    const id = profile.samples[index]
    const duration = profile.timeDeltas?.[index] ?? 0
    const visited = new Set()
    let cursor = id
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor)
      const cost = costs.get(cursor) ?? { selfUs: 0, totalUs: 0, samples: 0 }
      cost.totalUs += duration
      if (cursor === id) {
        cost.selfUs += duration
        cost.samples += 1
      }
      costs.set(cursor, cost)
      cursor = parents.get(cursor)
    }
  }
  return [...costs]
    .map(([id, cost]) => ({
      function: nodes.get(id)?.callFrame.functionName ?? '(unknown)',
      location: sourceLocation(
        nodes.get(id)?.callFrame ?? { lineNumber: -1, columnNumber: -1 },
        maps
      ),
      selfMs: cost.selfUs / 1000,
      totalMs: cost.totalUs / 1000,
      samples: cost.samples,
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 50)
}

export function analyzeTrace(trace) {
  const totals = new Map()
  const longTasks = []
  for (const event of trace.traceEvents ?? []) {
    if (event.ph !== 'X' || typeof event.dur !== 'number') continue
    const key = `${event.pid}:${event.tid}:${event.name}`
    const total = totals.get(key) ?? {
      name: event.name,
      pid: event.pid,
      tid: event.tid,
      count: 0,
      durationMs: 0,
    }
    total.count += 1
    total.durationMs += event.dur / 1000
    totals.set(key, total)
    if (event.dur >= 50_000 && /RunTask|ProcessTask/.test(event.name)) {
      longTasks.push({
        name: event.name,
        pid: event.pid,
        tid: event.tid,
        startUs: event.ts,
        durationMs: event.dur / 1000,
      })
    }
  }
  return {
    longTasks: longTasks.sort((a, b) => b.durationMs - a.durationMs).slice(0, 50),
    timings: [...totals.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 50),
  }
}

export function analyzeNetwork(events) {
  const requests = new Map()
  const completed = []
  for (const { method, params: p } of events) {
    if (method === 'Network.requestWillBeSent') {
      if (p.redirectResponse && requests.has(p.requestId)) {
        completed.push({
          ...requests.get(p.requestId),
          status: p.redirectResponse.status,
          durationMs: (p.timestamp - requests.get(p.requestId).start) * 1000,
          redirected: true,
        })
      }
      requests.set(p.requestId, {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        start: p.timestamp,
        initiator: p.initiator,
      })
    }
    const request = requests.get(p.requestId)
    if (!request) continue
    if (method === 'Network.responseReceived') {
      Object.assign(request, {
        status: p.response.status,
        timing: p.response.timing,
        fromDiskCache: p.response.fromDiskCache,
      })
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      completed.push({
        ...request,
        durationMs: (p.timestamp - request.start) * 1000,
        bytes: p.encodedDataLength,
        error: p.errorText,
      })
      requests.delete(p.requestId)
    }
  }
  return {
    requests: completed.sort((a, b) => b.durationMs - a.durationMs),
    pending: [...requests.values()],
  }
}

export async function stopPerformanceRecording(client, directory, target, outputPath) {
  const statePath = join(directory, `performance-${target}.json`)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const command = (method, params) => client({ action: 'command', target, method, params })
  const { profile } = await command('Profiler.stop')
  let failure
  let tracingEnded = false
  try {
    await command('Tracing.end')
    tracingEnded = true
    return await finishPerformanceRecording(client, command, target, state, profile, outputPath)
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (!tracingEnded) await command('Tracing.end').catch(() => {})
    await rm(statePath, { force: true }).catch(error => {
      if (!failure) throw error
    })
  }
}

async function finishPerformanceRecording(client, command, target, state, profile, outputPath) {
  const events = []
  let cursor = state.after
  let lost = 0
  let complete
  const deadline = Date.now() + 30_000
  while (!complete) {
    const page = await collectProtocolEvents(client, target, cursor)
    events.push(...page.events)
    lost += page.lost
    cursor = page.cursor
    complete = events.find(event => event.method === 'Tracing.tracingComplete')
    if (!page.attached) throw new Error('DevTools detached during recording')
    if (Date.now() > deadline) throw new Error('Timed out waiting for Tracing.tracingComplete')
    if (!complete) await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!complete.params.stream) throw new Error('Trace did not return a stream')
  const trace = JSON.parse(await readProtocolStream(command, complete.params.stream))
  const metrics = await command('Performance.getMetrics')
  await writeDiagnosticFile(outputPath + '.evidence.json', {
    profile,
    trace,
    events,
    metadata: state.metadata,
  })
  const { maps, errors } = await loadSourceMaps(command, [...state.metadata, ...events], profile)
  const report = {
    target,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    evidence: {
      lostEvents: lost,
      traceDataLoss: complete.params.dataLossOccurred ?? false,
      sourceMapErrors: errors,
      metadataLostEvents: state.metadataLostEvents,
    },
    cpu: analyzeCpuProfile(profile, maps),
    trace: analyzeTrace(trace),
    network: analyzeNetwork(events),
    console: events.filter(
      event =>
        ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(
          event.method
        ) &&
        (event.params.timestamp ?? event.params.entry?.timestamp ?? event.timestamp) >=
          state.startedAt
    ),
    metrics,
    baseline: state.baseline,
    notes: [
      'CPU costs are sampled; inclusive costs and nested trace durations must not be added together.',
      'Missing source maps retain generated locations; missing events make the report incomplete.',
    ],
  }
  await writeDiagnosticFile(outputPath, report)
  return {
    outputPath,
    evidencePath: outputPath + '.evidence.json',
    lostEvents: lost,
    sourceMapErrors: errors.length,
  }
}
