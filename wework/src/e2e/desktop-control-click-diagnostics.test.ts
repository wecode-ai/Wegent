import { afterEach, expect, test } from 'vitest'
import { desktopControlClickDiagnostics } from './desktop-control-click-diagnostics'

afterEach(() => document.body.replaceChildren())

test('identifies the selected hidden retained node even when another match is visible', () => {
  document.body.innerHTML = `<section data-workspace-tab-content aria-hidden="false">
    <div style="display:none" inert><button>Private content</button></div>
    <button>Visible content</button></section>`
  const buttons = Array.from(document.querySelectorAll('button'))
  const result = desktopControlClickDiagnostics(
    buttons[0]!,
    buttons,
    element => element === buttons[1],
    false
  )
  expect(result).toEqual({
    requestedVisible: false,
    selectedVisible: false,
    selectedConnected: true,
    selectedIndex: 0,
    sampledMatchCount: 2,
    sampledVisibleCount: 1,
    matchesTruncated: false,
    hiddenAncestor: true,
    inertAncestor: true,
    workspacePresent: true,
    workspaceActive: true,
  })
  expect(buttons[0]!.textContent).toBe('Private content')
})

test('reports a visible selected target without exporting DOM content or attributes', () => {
  const button = document.createElement('button')
  button.dataset.testid = 'private-record-id'
  button.textContent = 'private prompt'
  document.body.append(button)
  const result = desktopControlClickDiagnostics(button, [button], () => true, true)
  expect(result.selectedVisible).toBe(true)
  expect(result.hiddenAncestor).toBe(false)
  expect(result.workspacePresent).toBe(false)
  expect(Object.values(result).every(value => ['boolean', 'number'].includes(typeof value))).toBe(
    true
  )
})

test('bounds visibility sampling and marks matches outside the sample', () => {
  const buttons = Array.from({ length: 20 }, () => document.createElement('button'))
  document.body.append(...buttons)
  let reads = 0
  const result = desktopControlClickDiagnostics(
    buttons[19]!,
    buttons,
    () => {
      reads += 1
      return true
    },
    false
  )
  expect(result.sampledMatchCount).toBe(16)
  expect(result.selectedIndex).toBe(-1)
  expect(result.matchesTruncated).toBe(true)
  expect(reads).toBe(17)
})
