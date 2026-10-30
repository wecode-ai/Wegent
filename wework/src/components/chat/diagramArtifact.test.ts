import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useDiagramArtifact } from '../../../../packages/collaboration/src/markdown/useDiagramArtifact'
import {
  getDiagramResource,
  type DiagramRequest,
} from '../../../../packages/collaboration/src/markdown/diagramArtifact'

const renderArtifact = vi.hoisted(() => vi.fn())
vi.mock('../../../../packages/collaboration/src/markdown/renderDiagramArtifact', () => ({
  renderDiagramArtifact: renderArtifact,
}))
const artifact = { svg: '<svg />', src: 'data:image/svg+xml,test', width: 100, height: 50 }
const request: DiagramRequest = { code: 'graph LR\nA --> B', kind: 'mermaid', theme: 'light' }
const scope = () => document.implementation.createHTMLDocument()
const settle = () =>
  vi.waitFor(() => expect(renderArtifact.mock.results.at(-1)?.type).toBe('return'))

test('shares in-flight work and ready results across unmounts, with theme and server isolation', async () => {
  renderArtifact.mockReset().mockResolvedValue(artifact)
  const doc = scope()
  const first = getDiagramResource(doc, request)
  const second = getDiagramResource(doc, {
    ...request,
    plantumlServerUrl: 'https://ignored-for-mermaid/svg',
  })
  expect(first).toBe(second)
  const unsubscribe = first.subscribe(() => {})
  first.prepare()
  second.prepare()
  await vi.waitFor(() => expect(first.getSnapshot()).toEqual({ status: 'ready', artifact }))
  expect(renderArtifact).toHaveBeenCalledTimes(1)
  unsubscribe()
  expect(getDiagramResource(doc, request)).toBe(first)
  expect(getDiagramResource(doc, { ...request, theme: 'dark' })).not.toBe(first)
  const plant = { ...request, kind: 'plantuml' as const, plantumlServerUrl: 'https://one/svg' }
  expect(getDiagramResource(doc, plant)).not.toBe(
    getDiagramResource(doc, { ...plant, plantumlServerUrl: 'https://two/svg' })
  )
  expect(getDiagramResource(scope(), request)).not.toBe(first)
})

test('evicts compiled results by entry count and serialized size', async () => {
  renderArtifact.mockReset().mockResolvedValue(artifact)
  const doc = scope()
  const first = getDiagramResource(doc, request)
  for (let index = 0; index < 32; index++)
    getDiagramResource(doc, { ...request, code: `graph-${index}` })
  expect(getDiagramResource(doc, request)).not.toBe(first)
  const big = getDiagramResource(doc, { ...request, code: 'large-result' })
  const stop = big.subscribe(() => {})
  renderArtifact.mockResolvedValue({ ...artifact, svg: 'x'.repeat(2_097_152) })
  big.prepare()
  await vi.waitFor(() => expect(big.getSnapshot().status).toBe('ready'))
  expect(getDiagramResource(doc, { ...request, code: 'large-result' })).toBe(big)
  stop()
  expect(getDiagramResource(doc, { ...request, code: 'large-result' })).not.toBe(big)
})

test('does not poison the cache on failure and supports an explicit retry', async () => {
  renderArtifact.mockReset().mockRejectedValueOnce(new Error('invalid')).mockResolvedValue(artifact)
  const doc = scope()
  const resource = getDiagramResource(doc, request)
  const stop = resource.subscribe(() => {})
  resource.prepare()
  await vi.waitFor(() => expect(resource.getSnapshot().status).toBe('error'))
  resource.prepare()
  await vi.waitFor(() => expect(resource.getSnapshot()).toEqual({ status: 'ready', artifact }))
  expect(renderArtifact).toHaveBeenCalledTimes(2)
  expect(getDiagramResource(doc, request)).toBe(resource)
  stop()
})

test('late completion from a previous source never replaces the current diagram', async () => {
  renderArtifact.mockReset()
  const finish = new Map<string, (value: typeof artifact) => void>()
  renderArtifact.mockImplementation(
    (_doc, input: DiagramRequest) => new Promise(resolve => finish.set(input.code, resolve))
  )
  const { result, rerender, unmount } = renderHook(
    ({ code }) => useDiagramArtifact({ ...request, code }, true),
    { initialProps: { code: 'previous-hook-source' } }
  )
  await vi.waitFor(() => expect(finish.has('previous-hook-source')).toBe(true))
  rerender({ code: 'current-hook-source' })
  await vi.waitFor(() => expect(finish.has('current-hook-source')).toBe(true))
  const current = { ...artifact, src: 'current-image' }
  await act(async () => finish.get('current-hook-source')!(current))
  expect(result.current).toMatchObject({ status: 'ready', artifact: current })
  await act(async () => finish.get('previous-hook-source')!(artifact))
  expect(result.current).toMatchObject({ status: 'ready', artifact: current })
  unmount()
})

test('keeps in-flight and displayed diagrams shared when idle entries exceed the cache budget', async () => {
  renderArtifact.mockReset()
  let finish!: (value: typeof artifact) => void
  renderArtifact.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const doc = scope()
  const active = getDiagramResource(doc, request)
  const stop = active.subscribe(() => {})
  active.prepare()
  await settle()
  for (let index = 0; index < 40; index++)
    getDiagramResource(doc, { ...request, code: `pressure-${index}` })
  expect(getDiagramResource(doc, request)).toBe(active)
  finish(artifact)
  await vi.waitFor(() => expect(active.getSnapshot().status).toBe('ready'))
  expect(getDiagramResource(doc, request)).toBe(active)
  stop()
})

test('resumes when a queued render is skipped while a new subscriber arrives', async () => {
  renderArtifact.mockReset()
  let complete!: (value: typeof artifact | undefined) => void
  renderArtifact
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    .mockResolvedValue(artifact)
  const resource = getDiagramResource(scope(), request)
  const stop = resource.subscribe(() => {})
  resource.prepare()
  await settle()
  stop()
  const nextStop = resource.subscribe(() => {})
  resource.prepare()
  complete(undefined)
  await vi.waitFor(() => expect(resource.getSnapshot().status).toBe('ready'))
  expect(renderArtifact).toHaveBeenCalledTimes(2)
  nextStop()
})
