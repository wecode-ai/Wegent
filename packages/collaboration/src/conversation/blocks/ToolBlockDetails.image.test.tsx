// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderBlockDetail } from './ToolBlockDetails'
import type { ToolBlock } from './types'
import { ConversationTranslationProvider } from '../ConversationTranslation'
import { ToolInteractionServicesProvider } from '../ToolInteractionServices'
import { createCollaborationTranslator } from '../../i18n'

let root: Root
let container: HTMLDivElement
let originalCreate: PropertyDescriptor | undefined
let originalRevoke: PropertyDescriptor | undefined
const createUrl = vi.fn(),
  revokeUrl = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  createUrl.mockReset().mockImplementation(() => `blob:image-${createUrl.mock.calls.length}`)
  revokeUrl.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const [name, descriptor] of [
    ['createObjectURL', originalCreate],
    ['revokeObjectURL', originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor)
    else Reflect.deleteProperty(URL, name)
  }
})
function held() {
  let resolve!: (value: Blob) => void
  const promise = new Promise<Blob>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function render(path: string, read: (path: string) => Promise<Blob>) {
  const block: ToolBlock = {
    id: 'image',
    subtaskId: 1,
    type: 'tool',
    toolName: 'view_image',
    toolInput: { path },
    status: 'done',
    createdAt: 0,
  }
  await act(async () =>
    root.render(
      <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
        <ToolInteractionServicesProvider value={{ readImageFile: read }}>
          {renderBlockDetail(block)}
        </ToolInteractionServicesProvider>
      </ConversationTranslationProvider>
    )
  )
}

test('keeps the newer tool image when a previous file read arrives late and releases both URLs', async () => {
  const old = held(),
    current = held()
  const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  await render('/first.png', read)
  await render('/second.png', read)
  await act(async () => current.resolve(new Blob(['current'], { type: 'image/png' })))
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:image-1')
  await act(async () => old.resolve(new Blob(['old'], { type: 'image/png' })))
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:image-1')
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:image-2')
  act(() => root.render(null))
  expect(revokeUrl).toHaveBeenCalledWith('blob:image-1')
  expect(revokeUrl).toHaveBeenCalledTimes(2)
})
