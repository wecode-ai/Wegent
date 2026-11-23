import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopCpuMetrics, readLinuxCpuCounters } from './desktop-cpu-benchmark.mjs'

test('reports separate CPU-time deltas across all measured threads and renderers', () => {
  const stat = '42 (renderer ) worker) S 1 2 3 4 5 6 7 8 9 10 25 5 999 999 0 0 1 0 77'
  const renderer = readLinuxCpuCounters(42, stat)
  const otherRenderer = { pid: 43, startedAt: 78, ticks: 100 }
  const executor = { pid: 44, startedAt: 79, ticks: 40 }
  const before = { Renderer: [renderer, otherRenderer], Executor: [executor] }
  const after = {
    Renderer: [
      { ...otherRenderer, ticks: 101 },
      { ...renderer, ticks: 35 },
    ],
    Executor: [{ ...executor, ticks: 48 }],
  }

  assert.deepEqual(renderer, { pid: 42, startedAt: 77, ticks: 30 })
  assert.deepEqual(desktopCpuMetrics(before, after, 100, 90), [
    { name: 'Renderer CPU time', unit: 'ms', value: 60 },
    { name: 'Executor CPU time', unit: 'ms', value: 80 },
  ])
  assert.throws(
    () =>
      desktopCpuMetrics(before, { ...after, Executor: [{ ...executor, startedAt: 80 }] }, 100, 90),
    /Executor process identity changed/
  )
})

test('counts new renderers and rejects incomplete renderer samples', () => {
  const renderer = { pid: 42, startedAt: 77, ticks: 30 }
  const executor = { pid: 44, startedAt: 79, ticks: 40 }
  const newRenderer = { pid: 45, startedAt: 91, ticks: 7 }
  const before = { Renderer: [renderer], Executor: [executor] }
  const after = {
    Renderer: [{ ...renderer, ticks: 35 }, newRenderer],
    Executor: [executor],
  }

  assert.equal(desktopCpuMetrics(before, after, 100, 90)[0].value, 120)
  assert.throws(
    () => desktopCpuMetrics(before, after, 100, 92),
    /Renderer was missing from the initial sample/
  )
  assert.throws(
    () => desktopCpuMetrics(before, { ...after, Renderer: [newRenderer] }, 100, 90),
    /Renderer process disappeared during measurement/
  )
})
