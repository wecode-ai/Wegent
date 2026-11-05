// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { SourceMap } from 'node:module'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
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
} from './ai-verify-devtools.mjs'

describe('DevTools evidence analysis', () => {
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
