import { expect, test, vi } from 'vitest'
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
