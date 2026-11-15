import '@/i18n'
import { render, waitFor } from '@testing-library/react'
import { FileDiff } from '@pierre/diffs'
import { describe, expect, test, vi } from 'vitest'
import { FileChangesReviewPanel } from './FileChangesReviewPanel'
import type { ReactNode } from 'react'

vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

const diff = [
  'diff --git a/example.ts b/example.ts',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -1 +1 @@',
  '-const oldValue = 1',
  '+const newValue = 2',
].join('\n')

describe('diff render lifetime', () => {
  test('preserves code DOM through owner refreshes and releases it on unmount', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    const cleanUp = vi.spyOn(FileDiff.prototype, 'cleanUp')
    const { rerender, unmount } = render(
      <FileChangesReviewPanel
        loading={false}
        diff={diff}
        reviewMode="unstaged"
        onOpenSourceFile={() => {}}
      />
    )
    const code = () =>
      document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')
    await waitFor(() => expect(code()).toBeTruthy())
    const line = code()
    for (let index = 0; index < 10; index++) {
      rerender(
        <FileChangesReviewPanel
          loading={false}
          diff={diff}
          reviewMode="unstaged"
          reviewTitle={`refresh ${index}`}
          onOpenSourceFile={() => {}}
        />
      )
      expect(code()).toBe(line)
      expect(line?.isConnected).toBe(true)
    }
    unmount()
    expect(cleanUp).toHaveBeenCalled()
    expect(line?.isConnected).toBe(false)
  })
})
