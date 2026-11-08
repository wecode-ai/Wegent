import { highlightCode } from './highlightCode'

self.onmessage = (event: MessageEvent<{ id: number; code: string; language: string }>) => {
  const { id, code, language } = event.data
  try {
    self.postMessage({ id, result: highlightCode(code, language) })
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
