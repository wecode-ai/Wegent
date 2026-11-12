// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { ProjectShell } from './ProjectShell'

test('accounts for host actions without oscillating when their labels collapse', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const clientWidth = vi
    .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'cloud-project-header' ? 600 : 0
    })
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      let width = 0
      if (this.dataset.testid === 'cloud-project-header-title') width = 100
      if (this.dataset.testid === 'test-project-views')
        width = this.dataset.compact === 'true' ? 96 : 300
      if (this.dataset.testid === 'cloud-project-header-actions') {
        width = this.textContent === 'Expanded host action' ? 260 : 40
      }
      return new DOMRect(0, 0, width, 32)
    })
  try {
    act(() =>
      root.render(
        <ProjectShell
          assistantOpen={false}
          boardView={false}
          embedded
          hasCreateAction={false}
          sidebarCollapsed={false}
          title="Project"
          titleIcon={null}
          renderRightActions={({ showLabels }) => (
            <button type="button" data-testid="test-host-action" aria-label="Host action">
              {showLabels ? 'Expanded host action' : '+'}
            </button>
          )}
          renderViewSwitcher={({ compact, containerRef }) => (
            <nav
              ref={containerRef}
              data-testid="test-project-views"
              data-compact={compact}
            >
              Views
            </nav>
          )}
        >
          Content
        </ProjectShell>,
      ),
    )
    expect(
      container
        .querySelector('[data-testid="test-project-views"]')
        ?.getAttribute('data-compact'),
    ).toBe('true')
    expect(container.querySelector('button')?.textContent).toBe('+')
  } finally {
    act(() => root.unmount())
    clientWidth.mockRestore()
    bounds.mockRestore()
    container.remove()
  }
})
