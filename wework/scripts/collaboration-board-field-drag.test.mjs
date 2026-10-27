import { beforeEach, expect, test, vi } from 'vitest'
import { verifyReadOnlyBoardDrag } from '../e2e/desktop/modules/collaboration-board-field-drag.mjs'
import {
  openProjectBoard,
  selectProjectBoardGrouping,
} from '../e2e/desktop/modules/collaboration-board-personal-view.mjs'

vi.mock('../e2e/desktop/modules/collaboration-board-personal-view.mjs', () => ({
  openProjectBoard: vi.fn(),
  selectProjectBoardGrouping: vi.fn(),
  selectProjectBoardSort: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({ reloadMainWindow: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

function fixture({ dragHandle = '', mutate = false } = {}) {
  let visibleCard = null
  let reads = 0
  const issue = { id: 'moving', version: 1, status: 'inbox', priority: 'low', tags: ['viewer-A'] }
  const hideCards = () => {
    visibleCard = null
  }
  vi.mocked(selectProjectBoardGrouping).mockImplementation(hideCards)
  vi.mocked(openProjectBoard).mockImplementation(hideCards)
  const control = {
    command: vi.fn(async (method, selector, options) => {
      if (method === 'scrollIntoView') visibleCard = selector
      if (method === 'waitFor' && options?.visible === true) expect(visibleCard).toBe(selector)
      if (method === 'getAttribute') return dragHandle
      return ''
    }),
  }
  const request = vi.fn(async () => ({ ...issue, version: mutate && reads++ > 0 ? 2 : 1 }))
  const options = {
    scoped: selector => selector,
    request,
    project: { id: 'project' },
    issues: [issue, { id: 'anchor' }],
    reader: { id: 1 },
    owner: { id: 2 },
  }
  return { control, options, request }
}

test('reveals Viewer cards before visibility assertions, including after every reload', async () => {
  const { control, options, request } = fixture()
  await verifyReadOnlyBoardDrag(control, options)
  expect(control.command.mock.calls.filter(([method]) => method === 'scrollIntoView')).toHaveLength(
    8
  )
  expect(control.command.mock.calls.filter(([method]) => method === 'drag')).toHaveLength(4)
  expect(request).toHaveBeenCalledTimes(8)
})

test('still rejects an enabled Viewer drag handle', async () => {
  const { control, options } = fixture({ dragHandle: 'draggable' })
  await expect(verifyReadOnlyBoardDrag(control, options)).rejects.toThrow('enabled drag handle')
})

test('still rejects a persisted mutation after a Viewer drag', async () => {
  const { control, options } = fixture({ mutate: true })
  await expect(verifyReadOnlyBoardDrag(control, options)).rejects.toThrow(
    'Viewer drag changed version'
  )
})
