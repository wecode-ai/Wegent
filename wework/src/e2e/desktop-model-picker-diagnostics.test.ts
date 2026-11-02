import { afterEach, expect, test, vi } from 'vitest'
import { captureDesktopModelPickerDiagnostics } from './desktop-model-picker-diagnostics'

afterEach(() => {
  document.body.innerHTML = ''
})

test('preserves duplicate option identities and their menu boundaries', () => {
  document.body.innerHTML = `
    <div data-testid="model-selector-menu" data-panel="advanced">
      <button data-testid="model-option-luna" data-model-provider-id="provider-a"></button>
    </div>
    <div data-testid="model-selector-submenu" aria-hidden="true" inert>
      <button data-testid="model-option-luna" data-model-provider-id="provider-b"></button>
    </div>
    <button data-testid="model-option-luna"></button>
  `
  const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
  const isVisible = vi.fn((element: HTMLElement) => !element.closest('[aria-hidden="true"]'))

  const diagnostics = captureDesktopModelPickerDiagnostics(elements, isVisible)
  const options = diagnostics.filter(item => item.testId === 'model-option-luna')

  expect(options).toMatchObject([
    {
      providerId: 'provider-a',
      menuTestId: 'model-selector-menu',
      menuPanel: 'advanced',
      visible: true,
      hiddenAncestor: false,
      inertAncestor: false,
    },
    {
      providerId: 'provider-b',
      menuTestId: 'model-selector-submenu',
      menuPanel: null,
      visible: false,
      hiddenAncestor: true,
      inertAncestor: true,
    },
    { providerId: null, menuTestId: null, menuPanel: null, visible: true },
  ])
  expect(isVisible.mock.calls.map(([element]) => element)).toEqual(elements)
})

test('captures geometry without collecting field values, text, or unrelated attributes', () => {
  document.body.innerHTML = `
    <button data-testid="model-selector-button" data-private="private-metadata">private-label</button>
    <input data-testid="password-input" type="password" value="private-value">
  `
  const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
  vi.spyOn(elements[0], 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 34, 56, 78))

  const diagnostics = captureDesktopModelPickerDiagnostics(elements, () => true)

  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]).toEqual({
    testId: 'model-selector-button',
    providerId: null,
    menuTestId: null,
    menuPanel: null,
    visible: true,
    hiddenAncestor: false,
    inertAncestor: false,
    rect: { x: 12, y: 34, width: 56, height: 78 },
  })
  expect(JSON.stringify(diagnostics)).not.toContain('private-')
})
