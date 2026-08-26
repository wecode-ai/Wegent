import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

const electronHostInvokePath = '/wework/electron-host/v1/invoke'
const nativeFetch = globalThis.fetch.bind(globalThis)
let testAppPreferences: Record<string, unknown> = {}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' || input instanceof URL ? String(input) : input.url
}

async function defaultElectronHostFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (requestUrl(input) !== electronHostInvokePath) {
    return nativeFetch(input, init)
  }

  const request = JSON.parse(String(init?.body ?? '{}')) as {
    capability?: string
    params?: { patch?: Record<string, unknown> }
  }
  if (request.capability === 'preferences.get') {
    return Response.json({ ok: true, result: { ...testAppPreferences } })
  }
  if (request.capability === 'preferences.update') {
    testAppPreferences = {
      ...testAppPreferences,
      ...(request.params?.patch ?? {}),
    }
    return Response.json({ ok: true, result: { ...testAppPreferences } })
  }

  return nativeFetch(input, init)
}

globalThis.fetch = defaultElectronHostFetch

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

// BlockNote's side menu hit-tests pointer targets on mouse move.
if (typeof document.elementsFromPoint === 'undefined') {
  document.elementsFromPoint = () => []
}

// Mantine (via BlockNote) queries the preferred color scheme on mount.
if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

type StorageName = 'localStorage' | 'sessionStorage'

function hasStorageApi(value: unknown): value is Storage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Storage).getItem === 'function' &&
    typeof (value as Storage).setItem === 'function' &&
    typeof (value as Storage).removeItem === 'function' &&
    typeof (value as Storage).clear === 'function'
  )
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(String(key)) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(String(key))
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value))
  }
}

function resolveTestStorage() {
  try {
    const localStorage = window.localStorage
    const sessionStorage = window.sessionStorage
    if (!hasStorageApi(localStorage) || !hasStorageApi(sessionStorage)) {
      throw new Error('Incomplete browser storage API')
    }
    return {
      constructor: window.Storage,
      localStorage,
      sessionStorage,
    }
  } catch {
    const localStorage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    Object.defineProperties(window, {
      localStorage: { configurable: true, value: localStorage },
      sessionStorage: { configurable: true, value: sessionStorage },
    })
    return {
      constructor: MemoryStorage,
      localStorage,
      sessionStorage,
    }
  }
}

const testStorage = resolveTestStorage()

Object.defineProperty(globalThis, 'Storage', {
  configurable: true,
  value: testStorage.constructor,
  writable: true,
})

function installStorageGlobal(name: StorageName) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: testStorage[name],
    writable: true,
  })
}

installStorageGlobal('localStorage')
installStorageGlobal('sessionStorage')

beforeEach(() => {
  testAppPreferences = {}
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
  // Task-dialog drafts persist to localStorage; keep tests isolated.
  localStorage.clear()
})
