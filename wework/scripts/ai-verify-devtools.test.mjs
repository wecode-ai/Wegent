// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { SourceMap } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  analyzeCpuProfile,
  analyzeNetwork,
  analyzeTrace,
  collectProtocolEvents,
  readProtocolStream,
  sourceLocation,
  readLocalSourceMap,
  startPerformanceRecording,
  stopPerformanceRecording,
  createDevtoolsClient,
} from './ai-verify-devtools.mjs'

describe('DevTools evidence analysis', () => {
  test('discards interrupted recording state only after an authenticated detach succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devtools-detach-'))
    const statePath = join(directory, 'performance-1.json')
    let rejectDetach = true
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer test-only-token')
      response.writeHead(rejectDetach ? 500 : 200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          rejectDetach
            ? { ok: false, error: 'Detach failed' }
            : { ok: true, data: { detached: true } }
        )
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      await mkdir(join(directory, 'desktop-control'))
      await writeFile(
        join(directory, 'desktop-control', 'instance.json'),
        JSON.stringify({ address: `127.0.0.1:${server.address().port}`, token: 'test-only-token' })
      )
      await writeFile(statePath, '{"target":1}')
      const client = await createDevtoolsClient(directory)
      await expect(client({ action: 'detach', target: 1 })).rejects.toThrow('Detach failed')
      expect(await readFile(statePath, 'utf8')).toContain('target')
      rejectDetach = false
      await expect(client({ action: 'detach', target: 1 })).resolves.toEqual({ detached: true })
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  })
  test.each(['trace-parse', 'report-write', 'profiler-stop'])(
    'recovers recording state after %s failure',
    async stage => {
      const directory = await mkdtemp(join(tmpdir(), 'devtools-recovery-'))
      const statePath = join(directory, 'performance-1.json')
      await writeFile(
        statePath,
        JSON.stringify({ target: 1, after: 0, metadata: [], baseline: {}, startedAt: Date.now() })
      )
      const calls = []
      const client = async input => {
        calls.push(input.method ?? input.action)
        if (input.action === 'events')
          return {
            events: [
              { sequence: 1, method: 'Tracing.tracingComplete', params: { stream: 'trace' } },
            ],
            next: 1,
            latest: 1,
            lost: 0,
            attached: true,
          }
        if (input.method === 'Profiler.stop') {
          if (stage === 'profiler-stop') throw new Error('Profiler stop failed')
          return { profile: { nodes: [], samples: [], timeDeltas: [] } }
        }
        if (input.method === 'IO.read')
          return {
            data: stage === 'trace-parse' ? 'invalid trace' : '{"traceEvents":[]}',
            eof: true,
          }
        return {}
      }
      try {
        const blocked = join(directory, 'blocked')
        await writeFile(blocked, 'a file cannot be an output directory')
        await expect(
          stopPerformanceRecording(client, directory, 1, join(blocked, 'report.json'))
        ).rejects.toThrow()
        if (stage === 'profiler-stop') {
          expect(await readFile(statePath, 'utf8')).toContain('target')
          expect(calls).not.toContain('Tracing.end')
        } else {
          await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(calls).toContain('IO.close')
          await expect(startPerformanceRecording(client, directory, 1)).resolves.toMatchObject({
            recording: true,
          })
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
  test('loads repository maps without following a page-declared map outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devtools-maps-'))
    const workspace = join(root, 'workspace')
    try {
      await mkdir(workspace)
      await writeFile(join(workspace, 'app.js.map'), '{"version":3}')
      await writeFile(join(root, 'outside.map'), 'private')
      await symlink(join(root, 'outside.map'), join(workspace, 'escape.map'))
      expect(
        await readLocalSourceMap(pathToFileURL(join(workspace, 'app.js.map')), workspace)
      ).toContain('version')
      await expect(
        readLocalSourceMap(pathToFileURL(join(workspace, 'escape.map')), workspace)
      ).rejects.toThrow('inside the verification repository')
      await expect(
        readLocalSourceMap(pathToFileURL(join(root, 'outside.map')), workspace)
      ).rejects.toThrow('inside the verification repository')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('attributes sampled self and inclusive costs through the call tree and maps zero-based positions', () => {
    const frame = {
      scriptId: '1',
      functionName: 'hot',
      url: 'file:///build/app.js',
      lineNumber: 0,
      columnNumber: 0,
    }
    const maps = new Map([
      [
        '1',
        {
          url: 'file:///build/app.js.map',
          map: new SourceMap({
            version: 3,
            sources: ['../src/app.ts'],
            names: [],
            mappings: 'AAMA',
          }),
        },
      ],
    ])
    const result = analyzeCpuProfile(
      {
        nodes: [
          { id: 1, callFrame: frame, children: [2] },
          { id: 2, callFrame: { ...frame, functionName: 'child' } },
        ],
        samples: [1, 2, 2],
        timeDeltas: [1000, 2000, 3000],
      },
      maps
    )
    expect(result[0]).toMatchObject({
      function: 'child',
      selfMs: 5,
      totalMs: 5,
      location: { mapped: true, source: '/src/app.ts', line: 7, column: 1 },
    })
    expect(result[1]).toMatchObject({ selfMs: 1, totalMs: 6 })
    expect(sourceLocation(frame)).toEqual({
      mapped: false,
      generated: { url: frame.url, line: 1, column: 1 },
    })
  })

  test('keeps redirects, failed and unfinished requests distinct', () => {
    const event = (method, params) => ({ method: 'Network.' + method, params })
    const report = analyzeNetwork([
      event('requestWillBeSent', {
        requestId: 'a',
        timestamp: 1,
        request: { url: '/a', method: 'GET' },
      }),
      event('requestWillBeSent', {
        requestId: 'a',
        timestamp: 2,
        request: { url: '/b', method: 'GET' },
        redirectResponse: { status: 302 },
      }),
      event('loadingFailed', { requestId: 'a', timestamp: 3, errorText: 'failed' }),
      event('requestWillBeSent', { requestId: 'c', timestamp: 4, request: { url: '/c' } }),
    ])
    expect(report.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: '/a', status: 302, redirected: true }),
        expect.objectContaining({ url: '/b', error: 'failed', durationMs: 1000 }),
      ])
    )
    expect(report.pending).toHaveLength(1)
    expect(
      analyzeTrace({
        traceEvents: [{ ph: 'X', name: 'RunTask', dur: 60_000, ts: 1, pid: 2, tid: 3 }],
      }).longTasks[0].durationMs
    ).toBe(60)
  })

  test('drains paginated events with loss accounting and closes protocol streams', async () => {
    const pages = [
      { events: [{ sequence: 2 }], next: 2, latest: 3, lost: 1, attached: true },
      { events: [{ sequence: 3 }], next: 3, latest: 3, lost: 0, attached: true },
    ]
    expect(await collectProtocolEvents(async () => pages.shift(), 1)).toMatchObject({
      lost: 1,
      cursor: 3,
      events: [{ sequence: 2 }, { sequence: 3 }],
    })
    const calls = []
    expect(
      await readProtocolStream(async method => {
        calls.push(method)
        return { data: 'aGk=', base64Encoded: true, eof: true }
      }, 'trace')
    ).toBe('hi')
    expect(calls).toEqual(['IO.read', 'IO.close'])
  })
})
