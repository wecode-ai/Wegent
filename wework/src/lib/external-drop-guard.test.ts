import { afterEach, describe, expect, test } from 'vitest'
import { installExternalDropGuard } from './external-drop-guard'

function createDragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

function createFile(name: string): File {
  return new File(['content'], name, { type: 'text/plain' })
}

function createDataTransfer(options: {
  types?: string[]
  data?: Record<string, string>
  files?: File[]
}): DataTransfer {
  const store = new Map<string, string>(Object.entries(options.data ?? {}))
  const types = options.types ?? Array.from(store.keys())
  const files = options.files ?? []
  return {
    types,
    getData: (type: string) => store.get(type) ?? '',
    setData: (type: string, value: string) => {
      store.set(type, value)
    },
    dropEffect: 'none',
    effectAllowed: 'none',
    files: files as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: () => {},
  } as DataTransfer
}

describe('external drop guard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('prevents drops of text/uri-list payloads', () => {
    const cleanup = installExternalDropGuard()
    const dataTransfer = createDataTransfer({
      types: ['text/uri-list'],
      data: { 'text/uri-list': 'https://example.com/path\r\n' },
    })
    const event = createDragEvent('drop', dataTransfer)

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    cleanup()
  })

  test('does not prevent drops of non-URL plain text', () => {
    const cleanup = installExternalDropGuard()
    const dataTransfer = createDataTransfer({
      types: ['text/plain'],
      data: { 'text/plain': 'some notes to paste' },
    })
    const event = createDragEvent('drop', dataTransfer)

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    cleanup()
  })

  test('prevents dragover of file payloads outside handled zones', () => {
    const cleanup = installExternalDropGuard()
    const dataTransfer = createDataTransfer({
      types: ['Files'],
      files: [createFile('notes.txt')],
    })
    const event = createDragEvent('dragover', dataTransfer)

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('none')
    cleanup()
  })
})
