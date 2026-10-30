import { expect, test, vi } from 'vitest'
import {
  renderDiagramArtifact,
  sanitizeDiagramSvg,
} from '../../../../packages/collaboration/src/markdown/renderDiagramArtifact'
const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: engine }))

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>diagram</text></svg>'

test('serializes Mermaid initialization with rendering and skips discarded queued requests', async () => {
  engine.initialize.mockClear()
  engine.render.mockReset()
  let finish!: (result: { svg: string }) => void
  engine.render
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue({ svg })
  const request = { code: 'graph LR\nA --> B', kind: 'mermaid' as const, theme: 'light' as const }
  const first = renderDiagramArtifact(document, request, () => true)
  const cancelled = renderDiagramArtifact(document, { ...request, code: 'discarded' }, () => false)
  const second = renderDiagramArtifact(document, { ...request, theme: 'dark' }, () => true)
  await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1))
  expect(engine.initialize).toHaveBeenCalledTimes(1)
  finish({ svg })
  expect(await first).toMatchObject({ width: 100, height: 50 })
  expect(await cancelled).toBeUndefined()
  expect(await second).toMatchObject({ width: 100, height: 50 })
  expect(engine.render).toHaveBeenCalledTimes(2)
  expect(engine.initialize.mock.calls.map(([config]) => config.theme)).toEqual(['default', 'dark'])
  expect(document.querySelector('[data-file-viewer-mermaid-isolate]')).toBeNull()
})

test('preserves multiline HTML label namespaces and local markers while removing executable and external resources', () => {
  const source = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="unsafe()">
    <style>@\69mport "https://tracker.invalid/style.css";</style>
    <defs><marker id="arrow"><path d="M0 0L10 10" /></marker></defs>
    <path marker-end="url(#arrow)" />
    <use href="#arrow" />
    <use id="external" href="https://tracker.invalid/asset.svg#arrow" />
    <foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml" onclick="unsafe()">First<br/>Second<img src="https://tracker.invalid/image" /><script>unsafe()</script></div></foreignObject>
    <rect id="css-resource" style="fill:u\72l('https://tracker.invalid/image')" />
    <rect id="multiline-css-resource" style="fill:url('
https://tracker.invalid/image
')" />
  </svg>`
  const clean = sanitizeDiagramSvg(document, source, true)
  expect(clean.getAttribute('onload')).toBeNull()
  expect(clean.querySelector('style')).toBeNull()
  expect(clean.querySelector('script')).toBeNull()
  expect(clean.querySelector('img')?.getAttribute('src')).toBeNull()
  expect(clean.querySelector('#external')?.getAttribute('href')).toBeNull()
  expect(clean.querySelector('#css-resource')?.getAttribute('style')).toBeNull()
  expect(clean.querySelector('#multiline-css-resource')?.getAttribute('style')).toBeNull()
  expect(clean.querySelector('use')?.getAttribute('href')).toBe('#arrow')
  expect(clean.querySelector('[marker-end]')?.getAttribute('marker-end')).toBe('url(#arrow)')
  expect(clean.textContent).toContain('First')
  expect(clean.textContent).toContain('Second')
  const serialized = new XMLSerializer().serializeToString(clean)
  const parsed = new DOMParser().parseFromString(serialized, 'image/svg+xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
  expect(parsed.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'br')).toHaveLength(1)
})
