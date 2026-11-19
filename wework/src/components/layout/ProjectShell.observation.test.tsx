import { act, cleanup, render } from '@testing-library/react'
import type { Ref } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ProjectShell } from '../../../../packages/collaboration/src/project-shell/ProjectShell'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(initialWidth = 800) {
  let width = initialWidth
  const observers: Array<{ deliver(): void; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'cloud-project-header' ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const widths: Record<string, number> = {
      'cloud-project-header-title': 100,
      'project-views': 160,
      'cloud-project-ask-ai': 200,
    }
    return new DOMRect(0, 0, widths[this.dataset.testid ?? ''] ?? 0, 32)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          deliver: () => callback([], this as unknown as ResizeObserver),
          disconnect: this.disconnect,
        })
      }
      observe() {}
    }
  )
  const props = {
    assistantAction: { label: 'Assistant', icon: null, onClick() {} },
    assistantOpen: false,
    boardView: false,
    embedded: true,
    hasCreateAction: false,
    sidebarCollapsed: false,
    title: 'Project',
    titleIcon: null,
    renderRightActions: ({ level }: { level: number }) => <span data-testid="level">{level}</span>,
    renderViewSwitcher: ({ containerRef }: { containerRef: Ref<HTMLElement> }) => (
      <nav ref={containerRef} data-testid="project-views">
        Views
      </nav>
    ),
    children: 'Content',
  }
  return {
    observers,
    props,
    resize(next: number) {
      width = next
      act(() => observers[0].deliver())
    },
  }
}

test('keeps one header observer across responsive state and parent renders', () => {
  const current = fixture()
  const view = render(<ProjectShell {...current.props} />)
  expect(current.observers).toHaveLength(1)
  current.resize(450)
  expect(view.getByTestId('level')).toHaveTextContent('1')
  view.rerender(<ProjectShell {...current.props} title="Updated project" />)
  expect(current.observers).toHaveLength(1)
  expect(current.observers[0].disconnect).not.toHaveBeenCalled()
  view.unmount()
  expect(current.observers[0].disconnect).toHaveBeenCalledOnce()
})

test('the retained observer measures current assistant state after props change', () => {
  const current = fixture(450)
  const view = render(<ProjectShell {...current.props} />)
  expect(view.getByTestId('level')).toHaveTextContent('1')
  view.rerender(<ProjectShell {...current.props} assistantOpen />)
  expect(view.getByTestId('level')).toHaveTextContent('0')
  current.resize(350)
  expect(view.getByTestId('level')).toHaveTextContent('0')
  expect(current.observers).toHaveLength(1)
})
