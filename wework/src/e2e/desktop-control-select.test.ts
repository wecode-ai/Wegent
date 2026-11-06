import { afterEach, expect, test, vi } from 'vitest'
import { chooseDesktopControlOption } from './desktop-control-select'

afterEach(() => document.body.replaceChildren())

test('chooses the current compact control after a wide tab is replaced', () => {
  const staleTab = document.createElement('button')
  const staleClick = vi.fn()
  staleTab.addEventListener('click', staleClick)
  document.body.append(staleTab)
  const compact = document.createElement('select')
  compact.innerHTML =
    '<option value="board">Board</option><option value="milestones">Milestones</option>'
  const change = vi.fn()
  compact.addEventListener('change', change)
  staleTab.replaceWith(compact)

  expect(
    chooseDesktopControlOption(document.body.firstElementChild as HTMLElement, 'milestones')
  ).toBe('Milestones')
  expect(compact.value).toBe('milestones')
  expect(change).toHaveBeenCalledOnce()
  expect(staleClick).not.toHaveBeenCalled()
})

test('clicks the current wide tab exactly once', () => {
  const tab = document.createElement('button')
  tab.textContent = 'Milestones'
  const click = vi.fn()
  tab.addEventListener('click', click)

  expect(chooseDesktopControlOption(tab, 'milestones')).toBe('Milestones')
  expect(click).toHaveBeenCalledOnce()
})

test('rejects an unavailable option and unrelated elements without acting', () => {
  const compact = document.createElement('select')
  compact.innerHTML = '<option value="board">Board</option>'
  const change = vi.fn()
  compact.addEventListener('change', change)
  expect(() => chooseDesktopControlOption(compact, 'milestones')).toThrow(
    'Unable to find select option'
  )
  expect(change).not.toHaveBeenCalled()
  expect(() => chooseDesktopControlOption(document.createElement('div'), 'board')).toThrow(
    'requires a select or button'
  )
})
