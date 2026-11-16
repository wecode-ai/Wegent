import DOMPurify from 'dompurify'
import type { DiagramArtifact, DiagramRequest } from './diagramArtifact'

let mermaidQueue: Promise<unknown> = Promise.resolve()
let nextId = 1

function unsafeCss(value: string): boolean {
  const decoded = value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\\r?\n/g, '')
    .replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex: string | undefined, character: string) =>
      hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : character
    )
  return (
    /@import/i.test(decoded) ||
    Array.from(decoded.matchAll(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi)).some(
      ([, , url]) => !url.trim().startsWith('#')
    )
  )
}

/** Preserve HTML labels while excluding executable content and external SVG resources. */
export function sanitizeDiagramSvg(
  document: Document,
  source: string,
  html: boolean
): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(source, html ? 'text/html' : 'image/svg+xml')
  if (parsed.querySelector('parsererror')) throw new Error('Invalid diagram SVG')
  const node = parsed.querySelector('svg')
  if (!node) throw new Error('Missing diagram SVG')
  const clean = DOMPurify.sanitize(node, {
    RETURN_DOM: true,
    ADD_TAGS: ['foreignObject', 'use'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'base',
      'link',
      'meta',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'option',
    ],
  }) as Element
  const svg = clean.matches('svg') ? clean : clean.querySelector('svg')
  if (!svg) throw new Error('Missing sanitized diagram SVG')
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      // HTML parsing preserves unqualified xmlns attributes; XMLSerializer supplies
      // namespace declarations itself. Keeping both produces an invalid SVG image.
      if (
        (/^xmlns(?::|$)/.test(name) &&
          attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/') ||
        /^on/i.test(name) ||
        ['src', 'srcset', 'action', 'formaction', 'poster', 'xml:base'].includes(name) ||
        (['href', 'xlink:href'].includes(name) && !attribute.value.trim().startsWith('#')) ||
        unsafeCss(attribute.value)
      )
        element.removeAttribute(attribute.name)
    }
    if (element.localName === 'style' && unsafeCss(element.textContent ?? '')) element.remove()
  }
  return document.importNode(svg, true) as unknown as SVGSVGElement
}

function artifactFromSvg(svg: SVGSVGElement): DiagramArtifact {
  const viewBox = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const positive = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
  const width = positive(
    viewBox?.[2],
    positive(Number.parseFloat(svg.getAttribute('width') ?? ''), 800)
  )
  const height = positive(
    viewBox?.[3],
    positive(Number.parseFloat(svg.getAttribute('height') ?? ''), 600)
  )
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  const source = new XMLSerializer().serializeToString(svg)
  return {
    svg: source,
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`,
    width,
    height,
  }
}

async function compileMermaid(
  document: Document,
  request: DiagramRequest
): Promise<DiagramArtifact> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: request.theme === 'dark' ? 'dark' : 'default',
  })
  const container = document.createElement('div')
  container.inert = true
  container.setAttribute('aria-hidden', 'true')
  container.setAttribute('data-file-viewer-mermaid-isolate', '')
  container.style.cssText =
    'position:fixed;inset:0;visibility:hidden;pointer-events:none;contain:layout style paint'
  document.body.append(container)
  try {
    const result = await mermaid.render(`conversation-diagram-${nextId++}`, request.code, container)
    return artifactFromSvg(sanitizeDiagramSvg(document, result.svg, true))
  } finally {
    container.remove()
  }
}

async function compilePlantuml(
  document: Document,
  request: DiagramRequest
): Promise<DiagramArtifact> {
  if (!request.plantumlServerUrl) throw new Error('PlantUML server is unavailable')
  const server = new URL(request.plantumlServerUrl, document.baseURI)
  if (!['https:', 'http:'].includes(server.protocol)) throw new Error('Invalid PlantUML server')
  const { encode } = await import('plantuml-encoder')
  const url = `${server.href.replace(/\/?$/, '/')}${encode(request.code)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error('PlantUML rendering failed')
  return artifactFromSvg(sanitizeDiagramSvg(document, await response.text(), false))
}

export function renderDiagramArtifact(
  document: Document,
  request: DiagramRequest,
  isNeeded: () => boolean
): Promise<DiagramArtifact | undefined> {
  const run = async () => {
    if (!isNeeded()) return undefined
    // Compilation is never performed inside the synchronous scroll commit.
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!isNeeded()) return undefined
    return request.kind === 'mermaid'
      ? compileMermaid(document, request)
      : compilePlantuml(document, request)
  }
  if (request.kind === 'plantuml') return run()
  // initialize() and render() must share one queue because Mermaid owns global configuration.
  const pending = mermaidQueue.then(run)
  mermaidQueue = pending.catch(() => undefined)
  return pending
}
