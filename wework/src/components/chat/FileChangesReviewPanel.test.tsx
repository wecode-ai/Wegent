import '@/i18n'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { FileChangesReviewPanel } from './FileChangesReviewPanel'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

function getRenderedDiffText() {
  return Array.from(document.querySelectorAll('diffs-container'))
    .map(container => container.shadowRoot?.textContent ?? '')
    .join('\n')
}

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

describe('FileChangesReviewPanel', () => {
  test('keeps every changed file diff visible when a file is selected', async () => {
    render(
      <FileChangesReviewPanel
        loading={false}
        diff={twoFileDiff}
        branchName="human/dingo-20260624-023038"
        targetBranchName="origin/main"
      />
    )

    const toolbar = screen.getByTestId('file-changes-review-toolbar')
    expect(within(toolbar).getByText(/Branch|分支/)).toBeInTheDocument()
    expect(within(toolbar).getByText('+2')).toBeInTheDocument()
    expect(within(toolbar).getByText('-2')).toBeInTheDocument()
    expect(within(toolbar).getByText('human/dingo-20260624-023038')).toBeInTheDocument()
    expect(within(toolbar).getByText('origin/main')).toBeInTheDocument()

    expect(screen.getByTestId('pierre-file-tree')).toBeInTheDocument()
    await waitFor(() => {
      expect(getRenderedDiffText()).toContain('new alpha')
      expect(getRenderedDiffText()).toContain('new beta')
    })

    const fileToggles = screen.getAllByTestId('file-changes-review-file-diff-toggle')
    expect(fileToggles).toHaveLength(2)

    await userEvent.click(fileToggles[0])
    expect(fileToggles[0]).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      expect(getRenderedDiffText()).not.toContain('new alpha')
      expect(getRenderedDiffText()).toContain('new beta')
    })

    await userEvent.click(fileToggles[0])
    expect(fileToggles[0]).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(getRenderedDiffText()).toContain('new alpha')
      expect(getRenderedDiffText()).toContain('new beta')
    })
  })

  test('renders changed files as a tree on the right side', async () => {
    render(<FileChangesReviewPanel loading={false} diff={treeDiff} />)

    const content = screen.getByTestId('file-changes-review-content')
    expect(content.children[0]).toHaveAttribute('data-testid', 'file-changes-review-diff')
    expect(content.children[1]).toHaveAttribute('data-testid', 'file-changes-review-file-tree')

    const tree = screen.getByTestId('file-changes-review-file-tree')
    expect(within(tree).getByTestId('file-changes-review-file-search-input')).toBeInTheDocument()
    expect(within(tree).getByTestId('pierre-file-tree')).toBeInTheDocument()

    await waitFor(() => {
      const diffText = getRenderedDiffText()
      expect(diffText).toContain('new test')
      expect(diffText).toContain('new component')
      expect(diffText).toContain('new english')
      expect(diffText).toContain('new chinese')
      expect(diffText.indexOf('new test')).toBeLessThan(diffText.indexOf('new component'))
      expect(diffText.indexOf('new component')).toBeLessThan(diffText.indexOf('new english'))
      expect(diffText.indexOf('new english')).toBeLessThan(diffText.indexOf('new chinese'))
    })
  })

  test('shows only the selected file when the diff is large', async () => {
    const { rerender } = render(
      <FileChangesReviewPanel
        loading={false}
        diff={largeDiff}
        reviewTitle="上轮对话"
        defaultFileTreeVisible={false}
      />
    )

    expect(screen.getByText(/This diff is large|此差异较大/)).toBeInTheDocument()
    expect(screen.getByTestId('file-changes-review-toolbar')).toHaveTextContent('上轮对话')
    expect(screen.queryByTestId('file-changes-review-file-tree')).not.toBeInTheDocument()

    const diff = screen.getByTestId('file-changes-review-diff')
    await waitFor(() => {
      expect(diff).toBeInTheDocument()
      expect(getRenderedDiffText()).toContain('new 1')
      expect(getRenderedDiffText()).not.toContain('new 2')
    })

    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    expect(screen.getByTestId('pierre-file-tree')).toBeInTheDocument()

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
      expect(getRenderedDiffText()).not.toContain('new 2')
      expect(getRenderedDiffText()).toContain('new 13')
    })
  })

  test('merges multiple diff blocks for the same file into one section', async () => {
    const duplicatePathDiff = [
      'diff --git a/src/env.ts b/src/env.ts',
      '--- a/src/env.ts',
      '+++ b/src/env.ts',
      '@@ -1 +1 @@',
      '-old staged',
      '+new staged',
      'diff --git a/src/env.ts b/src/env.ts',
      '--- a/src/env.ts',
      '+++ b/src/env.ts',
      '@@ -5 +5 @@',
      '-old unstaged',
      '+new unstaged',
    ].join('\n')

    render(<FileChangesReviewPanel loading={false} diff={duplicatePathDiff} />)

    expect(screen.getByTestId('pierre-file-tree')).toBeInTheDocument()

    const diff = screen.getByTestId('file-changes-review-diff')
    await waitFor(() => {
      expect(diff).toBeInTheDocument()
      expect(getRenderedDiffText()).toContain('new staged')
      expect(getRenderedDiffText()).toContain('new unstaged')
    })
  })

  test('keeps the review toolbar available when the selected view has no diff', async () => {
    const onSelectPreviousTurn = vi.fn()

    render(
      <FileChangesReviewPanel
        loading={false}
        diff=""
        reviewTitle="提交"
        viewOptions={[
          {
            id: 'commit',
            label: '提交',
            active: true,
            onSelect: vi.fn(),
          },
          {
            id: 'previous-turn',
            label: '上轮对话',
            active: false,
            onSelect: onSelectPreviousTurn,
          },
        ]}
      />
    )

    expect(screen.getByTestId('file-changes-review-toolbar')).toHaveTextContent('提交')
    expect(screen.getByTestId('file-changes-review-empty')).toHaveTextContent(
      /No text changes|没有可展示/
    )

    await userEvent.click(screen.getByTestId('review-view-switcher-button'))
    await userEvent.click(screen.getByRole('menuitemradio', { name: '上轮对话' }))

    expect(onSelectPreviousTurn).toHaveBeenCalledTimes(1)
  })

  test('supports review toolbar actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })

    const onRefresh = vi.fn()

    render(<FileChangesReviewPanel loading={false} diff={treeDiff} onRefresh={onRefresh} />)

    await userEvent.click(screen.getByTestId('refresh-review-diff-button'))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    expect(screen.queryByTestId('file-changes-review-file-tree')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    expect(screen.getByTestId('file-changes-review-file-tree')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('toggle-line-wrap-button'))
    expect(screen.getByTestId('file-changes-review-diff-lines')).toHaveAttribute(
      'data-wrap',
      'true'
    )

    await userEvent.click(screen.getByTestId('collapse-all-diff-hunks-button'))
    expect(screen.getByTestId('collapse-all-diff-hunks-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await userEvent.click(screen.getByTestId('copy-git-apply-command-button'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("git apply <<'PATCH'"))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(treeDiff))
  })
})
