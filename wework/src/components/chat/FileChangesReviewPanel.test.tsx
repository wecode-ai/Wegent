import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { FileChangesReviewPanel } from './FileChangesReviewPanel'
import type { ReactNode } from 'react'

vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: ReactNode }) => children,
}))

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})

function getRenderedDiffText() {
  return Array.from(document.querySelectorAll('diffs-container'))
    .map(container => container.shadowRoot?.textContent ?? '')
    .join('\n')
}

const largeDiff = Array.from({ length: 13 }, (_, index) => {
  const fileIndex = index + 1
  return [
    `diff --git a/src/file-${fileIndex}.ts b/src/file-${fileIndex}.ts`,
    `--- a/src/file-${fileIndex}.ts`,
    `+++ b/src/file-${fileIndex}.ts`,
    '@@ -1 +1 @@',
    `-old ${fileIndex}`,
    `+new ${fileIndex}`,
  ].join('\n')
}).join('\n')

const twoFileDiff = [
  'diff --git a/src/alpha.ts b/src/alpha.ts',
  '--- a/src/alpha.ts',
  '+++ b/src/alpha.ts',
  '@@ -1 +1 @@',
  '-old alpha',
  '+new alpha',
  'diff --git a/src/beta.ts b/src/beta.ts',
  '--- a/src/beta.ts',
  '+++ b/src/beta.ts',
  '@@ -1 +1 @@',
  '-old beta',
  '+new beta',
].join('\n')

const treeDiff = [
  'diff --git a/wework/src/components/chat/FileChangesReviewPanel.test.tsx b/wework/src/components/chat/FileChangesReviewPanel.test.tsx',
  '--- a/wework/src/components/chat/FileChangesReviewPanel.test.tsx',
  '+++ b/wework/src/components/chat/FileChangesReviewPanel.test.tsx',
  '@@ -1 +1 @@',
  '-old test',
  '+new test',
  'diff --git a/wework/src/components/chat/FileChangesReviewPanel.tsx b/wework/src/components/chat/FileChangesReviewPanel.tsx',
  '--- a/wework/src/components/chat/FileChangesReviewPanel.tsx',
  '+++ b/wework/src/components/chat/FileChangesReviewPanel.tsx',
  '@@ -1 +1 @@',
  '-old component',
  '+new component',
  '@@ -20 +20 @@',
  '-old second hunk',
  '+new second hunk',
  'diff --git a/wework/src/i18n/locales/en/chat.json b/wework/src/i18n/locales/en/chat.json',
  '--- a/wework/src/i18n/locales/en/chat.json',
  '+++ b/wework/src/i18n/locales/en/chat.json',
  '@@ -1 +1 @@',
  '-old english',
  '+new english',
  'diff --git a/wework/src/i18n/locales/zh-CN/chat.json b/wework/src/i18n/locales/zh-CN/chat.json',
  '--- a/wework/src/i18n/locales/zh-CN/chat.json',
  '+++ b/wework/src/i18n/locales/zh-CN/chat.json',
  '@@ -1 +1 @@',
  '-old chinese',
  '+new chinese',
].join('\n')

describe('FileChangesReviewPanel', () => {
  test('keeps the copy label when writing to the clipboard fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, {
      clipboard: { writeText },
    })

    render(<FileChangesReviewPanel loading={false} diff={treeDiff} />)

    const copyButton = screen.getByTestId('copy-git-apply-command-button')
    const copyLabel = copyButton.getAttribute('aria-label')
    await userEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(copyButton).toHaveAttribute('aria-label', copyLabel)
  })

  test('supports file-level staging and reverting in unstaged review', async () => {
    const onApplyPatch = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <FileChangesReviewPanel
        loading={false}
        diff={twoFileDiff}
        reviewMode="unstaged"
        onApplyPatch={onApplyPatch}
      />
    )

    const fileActions = screen.getAllByTestId('file-changes-review-file-actions')[0]
    const hunkActions = screen.getAllByTestId('file-changes-review-hunk-actions')[0]
    expect(fileActions).toHaveClass('opacity-0')
    expect(hunkActions).toHaveClass('absolute', 'rounded-full', 'opacity-0')
    expect(
      Array.from(fileActions.querySelectorAll('button')).map(button =>
        button.getAttribute('data-testid')
      )
    ).toEqual(['file-changes-review-revert-file-button', 'file-changes-review-stage-file-button'])
    expect(
      Array.from(hunkActions.querySelectorAll('button')).map(button =>
        button.getAttribute('data-testid')
      )
    ).toEqual(['file-changes-review-revert-hunk-button', 'file-changes-review-stage-hunk-button'])
    expect(screen.getAllByTestId('file-changes-review-stage-file-button')[0]).not.toHaveTextContent(
      /Stage file|暂存文件/
    )
    expect(screen.getAllByTestId('file-changes-review-stage-hunk-button')[0]).toHaveAccessibleName(
      /Stage$|暂存$/
    )

    await userEvent.click(screen.getAllByTestId('file-changes-review-stage-file-button')[0])
    expect(onApplyPatch).toHaveBeenCalledWith(
      'stage',
      expect.stringContaining('diff --git a/src/alpha.ts b/src/alpha.ts')
    )

    await userEvent.click(screen.getAllByTestId('file-changes-review-revert-file-button')[0])
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(onApplyPatch).toHaveBeenCalledWith(
      'revert',
      expect.stringContaining('diff --git a/src/alpha.ts b/src/alpha.ts')
    )
  })
  test('keeps all files in the virtualized review when the diff is large', async () => {
    const { rerender } = render(
      <FileChangesReviewPanel
        loading={false}
        diff={largeDiff}
        reviewTitle="上轮对话"
        defaultFileTreeVisible={false}
      />
    )

    expect(screen.queryByText(/This diff is large|此差异较大/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('file-changes-review-file-diff-section')).toHaveLength(13)
    expect(screen.getByTestId('file-changes-review-toolbar')).toHaveTextContent('上轮对话')
    expect(screen.getByTestId('file-changes-review-file-tree')).not.toBeVisible()
    expect(screen.getByTestId('toggle-file-tree-button')).toHaveAttribute('aria-pressed', 'false')

    const diff = screen.getByTestId('file-changes-review-diff')
    await waitFor(() => {
      expect(diff).toBeInTheDocument()
      expect(getRenderedDiffText()).toContain('new 1')
      expect(getRenderedDiffText()).toContain('new 2')
    })

    rerender(
      <FileChangesReviewPanel
        loading={false}
        diff={largeDiff}
        reviewTitle="上轮对话"
        defaultFileTreeVisible={false}
        focusFilePath="src/file-13.ts"
      />
    )

    await waitFor(() => {
      const lastSection = screen.getAllByTestId('file-changes-review-file-diff-section').at(-1)
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(lastSection)
    })
  })

  test('keeps multi-hunk files in one renderer and stages only the requested hunk', async () => {
    const onApplyPatch = vi.fn().mockResolvedValue(undefined)
    render(
      <FileChangesReviewPanel
        loading={false}
        diff={treeDiff}
        reviewMode="unstaged"
        onApplyPatch={onApplyPatch}
      />
    )
    await waitFor(() =>
      expect(screen.getAllByTestId('file-changes-review-stage-hunk-button')).toHaveLength(5)
    )
    expect(document.querySelectorAll('diffs-container')).toHaveLength(4)
    await userEvent.click(screen.getAllByTestId('file-changes-review-stage-hunk-button')[2])
    const patch = onApplyPatch.mock.calls[0]?.[1]
    expect(patch).toContain('@@ -20 +20 @@')
    expect(patch).toContain('+new second hunk')
    expect(patch).not.toContain('+new component')
    expect(patch).not.toContain('+new test')
  })
})
