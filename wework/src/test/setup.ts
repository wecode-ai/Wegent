import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

if (typeof window.ClipboardEvent === 'undefined') {
  window.ClipboardEvent = Event as unknown as typeof ClipboardEvent
}

const textPrototype = Text.prototype as Text & {
  getBoundingClientRect?: () => DOMRect
  getClientRects?: () => DOMRectList
}

if (typeof textPrototype.getBoundingClientRect === 'undefined') {
  textPrototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof textPrototype.getClientRects === 'undefined') {
  textPrototype.getClientRects = () => [] as unknown as DOMRectList
}

const nodePrototype = Node.prototype as Node & {
  getBoundingClientRect?: () => DOMRect
}

if (typeof nodePrototype.getBoundingClientRect === 'undefined') {
  nodePrototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof Range.prototype.getBoundingClientRect === 'undefined') {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof Range.prototype.getClientRects === 'undefined') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

if (typeof document.elementFromPoint === 'undefined') {
  document.elementFromPoint = () => null
}

beforeEach(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  })
  window.__WEWORK_RUNTIME_CONFIG__ = {
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: window.location.origin,
    socketPath: '/socket.io',
  }
})
