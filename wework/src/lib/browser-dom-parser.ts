const BrowserDOMParser = globalThis.DOMParser

if (!BrowserDOMParser) {
  throw new Error('DOMParser is unavailable in this browser runtime')
}

export { BrowserDOMParser as DOMParser }
