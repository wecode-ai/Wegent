// @vitest-environment jsdom
import JSZip from 'jszip'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { XMindPreview } from './XMindPreview'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function archive(title?: string) {
  const zip = new JSZip()
  zip.file('content.json', JSON.stringify(title ? [{ title: 'Sheet', rootTopic: { title } }] : []))
  return zip.generateAsync({ type: 'arraybuffer' })
}
function file(buffer: Promise<ArrayBuffer> | ArrayBuffer) {
  const result = new File([], 'diagram.xmind')
  Object.defineProperty(result, 'arrayBuffer', { value: async () => buffer })
  return result
}
function render(source: File, ready: () => void, error: (message: string) => void) {
  act(() =>
    root.render(
      <XMindPreview
        file={source}
        name="Diagram"
        loadingLabel="Loading"
        errorLabel="Invalid diagram"
        onReady={ready}
        onError={error}
      />
    )
  )
}

test('parses a real archive and clears the prior diagram while a new file is loading', async () => {
  const firstReady = held<void>(),
    secondReady = held<void>(),
    pending = held<ArrayBuffer>()
  const firstError = vi.fn(),
    secondError = vi.fn()
  render(file(await archive('First topic')), () => firstReady.resolve(), firstError)
  await act(async () => firstReady.promise)
  expect(container.textContent).toContain('First topic')
  render(file(pending.promise), () => secondReady.resolve(), secondError)
  expect(container.textContent).toBe('Loading')
  const bytes = await archive('Second topic')
  await act(async () => {
    pending.resolve(bytes)
    await secondReady.promise
  })
  expect(container.textContent).toContain('Second topic')
  expect(container.textContent).not.toContain('First topic')
  expect(firstError).not.toHaveBeenCalled()
  expect(secondError).not.toHaveBeenCalled()
})

test('reports an empty archive as a parse failure', async () => {
  const failed = held<string>(),
    ready = vi.fn()
  render(file(await archive()), ready, message => failed.resolve(message))
  await act(async () => {
    expect(await failed.promise).toBe('Invalid diagram')
  })
  expect(container.textContent).toBe('Invalid diagram')
  expect(ready).not.toHaveBeenCalled()
})
