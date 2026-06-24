import '@/i18n'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { FileChangesReviewPanel } from './FileChangesReviewPanel'

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

    const options = screen.getAllByTestId('file-changes-review-file-option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('file-changes-review-diff')).toHaveTextContent('new alpha')
    expect(screen.getByTestId('file-changes-review-diff')).toHaveTextContent('new beta')
    expect(screen.getByTestId('file-changes-review-diff')).not.toHaveTextContent('diff --git')
    expect(screen.getByTestId('file-changes-review-diff')).not.toHaveTextContent('@@ -1 +1 @@')

    await userEvent.click(options[1])

    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('file-changes-review-diff')).toHaveTextContent('new alpha')
    expect(screen.getByTestId('file-changes-review-diff')).toHaveTextContent('new beta')
  })

  test('renders changed files as a tree on the right side', async () => {
    render(<FileChangesReviewPanel loading={false} diff={treeDiff} />)

    const content = screen.getByTestId('file-changes-review-content')
    expect(content.children[0]).toHaveAttribute('data-testid', 'file-changes-review-diff')
    expect(content.children[1]).toHaveAttribute('data-testid', 'file-changes-review-file-tree')

    const tree = screen.getByTestId('file-changes-review-file-tree')
    expect(within(tree).getByText('wework')).toBeInTheDocument()
    expect(within(tree).getByText('src')).toBeInTheDocument()
    expect(within(tree).getByText('components')).toBeInTheDocument()
    expect(within(tree).getByText('chat')).toBeInTheDocument()
    expect(within(tree).getByText('i18n')).toBeInTheDocument()
    expect(within(tree).getByText('locales')).toBeInTheDocument()
    expect(within(tree).getByText('zh-CN')).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('tab', {
        name: /wework\/src\/i18n\/locales\/zh-CN\/chat\.json/,
      })
    )

    const selectedFile = screen.getByRole('tab', {
      name: /wework\/src\/i18n\/locales\/zh-CN\/chat\.json/,
    })
    expect(selectedFile).toHaveAttribute('aria-selected', 'true')

    const diffText = screen.getByTestId('file-changes-review-diff').textContent ?? ''
    expect(diffText).toContain('new test')
    expect(diffText).toContain('new component')
    expect(diffText).toContain('new english')
    expect(diffText).toContain('new chinese')
    expect(diffText.indexOf('new test')).toBeLessThan(diffText.indexOf('new component'))
    expect(diffText.indexOf('new component')).toBeLessThan(diffText.indexOf('new english'))
    expect(diffText.indexOf('new english')).toBeLessThan(diffText.indexOf('new chinese'))
  })

  test('shows only the selected file when the diff is large', async () => {
    render(
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
    expect(diff).toHaveTextContent('new 1')
    expect(diff).not.toHaveTextContent('new 2')
    expect(screen.getByText('new 1').closest('div')).toHaveClass('w-max', 'min-w-full')

    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    await userEvent.click(
      screen.getByRole('tab', {
        name: /src\/file-13\.ts/,
      })
    )

    expect(diff).not.toHaveTextContent('new 2')
    expect(diff).toHaveTextContent('new 13')
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

    await userEvent.click(
      screen.getByRole('tab', {
        name: /wework\/src\/components\/chat\/FileChangesReviewPanel\.tsx/,
      })
    )
    expect(screen.getAllByTestId('file-changes-review-hunk')).toHaveLength(5)

    await userEvent.click(screen.getByTestId('collapse-all-diff-hunks-button'))
    expect(screen.queryByText('new test')).not.toBeInTheDocument()
    expect(screen.queryByText('new component')).not.toBeInTheDocument()
    expect(screen.queryByText('new second hunk')).not.toBeInTheDocument()
    expect(screen.queryByText('new english')).not.toBeInTheDocument()
    expect(screen.queryByText('new chinese')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('copy-git-apply-command-button'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("git apply <<'PATCH'"))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(treeDiff))
  })
})
