const menuSelector = '[data-testid="model-selector-menu"], [data-testid="model-selector-submenu"]'

export function captureDesktopModelPickerDiagnostics(
  elements: HTMLElement[],
  isVisible: (element: HTMLElement) => boolean
) {
  return elements
    .filter(element => {
      const testId = element.dataset.testid
      return (
        testId?.startsWith('model-option-') ||
        testId === 'model-selector-button' ||
        testId === 'model-selector-menu' ||
        testId === 'model-selector-submenu'
      )
    })
    .map(element => {
      const menu = element.closest<HTMLElement>(menuSelector)
      const rect = element.getBoundingClientRect()
      return {
        testId: element.dataset.testid,
        providerId: element.getAttribute('data-model-provider-id'),
        menuTestId: menu?.dataset.testid ?? null,
        menuPanel: menu?.dataset.panel ?? null,
        visible: isVisible(element),
        hiddenAncestor: Boolean(element.closest('[aria-hidden="true"]')),
        inertAncestor: Boolean(element.closest('[inert]')),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })
}
