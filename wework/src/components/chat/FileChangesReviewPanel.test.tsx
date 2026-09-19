import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { FileChangesReviewPanel } from './FileChangesReviewPanel'

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
})

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
  test('syncs the tree while scrolling both ways without jumping the diff', async () => {
    render(<FileChangesReviewPanel loading={false} diff={twoFileDiff} />)

    const container = screen.getByTestId('file-changes-review-diff-lines')
    const sections = screen.getAllByTestId('file-changes-review-file-diff-section')
    const tree = screen.getByTestId('pierre-file-tree')
    const selectedFile = () =>
      tree.shadowRoot?.querySelector('[data-item-selected]')?.getAttribute('aria-label')
    Object.defineProperties(container, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    sections.forEach((section, index) => {
      vi.spyOn(section, 'getBoundingClientRect').mockImplementation(
        () => ({ bottom: 100 + (index + 1) * 600 - container.scrollTop }) as DOMRect
      )
    })

    await waitFor(() => expect(selectedFile()).toBe('alpha.ts'))
    vi.mocked(Element.prototype.scrollIntoView).mockClear()

    fireEvent.scroll(container, { target: { scrollTop: 650 } })
    await waitFor(() => expect(selectedFile()).toBe('beta.ts'))
    expect(container.scrollTop).toBe(650)
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()

    fireEvent.scroll(container, { target: { scrollTop: 200 } })
    await waitFor(() => expect(selectedFile()).toBe('alpha.ts'))
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()

    const beta = tree.shadowRoot?.querySelector('button[aria-label="beta.ts"]')
    expect(beta).toBeTruthy()
    await userEvent.click(beta as HTMLElement)
    await waitFor(() =>
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(sections[1])
    )

    const stopScroll = vi.fn()
    container.scrollTo = stopScroll
    fireEvent.wheel(container, { deltaY: 100 })
    expect(stopScroll).toHaveBeenCalledWith({ top: 200, left: 0, behavior: 'instant' })
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    fireEvent.scroll(container, { target: { scrollTop: 650 } })
    await waitFor(() => expect(selectedFile()).toBe('beta.ts'))
    fireEvent.scroll(container, { target: { scrollTop: 200 } })
    await waitFor(() => expect(selectedFile()).toBe('alpha.ts'))
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  test('selects a short final file when reaching the bottom of the diff', async () => {
    render(<FileChangesReviewPanel loading={false} diff={twoFileDiff} />)

    const container = screen.getByTestId('file-changes-review-diff-lines')
    const sections = screen.getAllByTestId('file-changes-review-file-diff-section')
    Object.defineProperties(container, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 700 },
    })
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    vi.spyOn(sections[0], 'getBoundingClientRect').mockReturnValue({ bottom: 400 } as DOMRect)
    vi.spyOn(sections[1], 'getBoundingClientRect').mockReturnValue({ bottom: 500 } as DOMRect)

    fireEvent.scroll(container, { target: { scrollTop: 300 } })

    await waitFor(() =>
      expect(
        screen.getByTestId('pierre-file-tree').shadowRoot?.querySelector('[data-item-selected]')
      ).toHaveAttribute('aria-label', 'beta.ts')
    )
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  test('cancels a pending file jump when the user resumes scrolling', async () => {
    render(<FileChangesReviewPanel loading={false} diff={twoFileDiff} />)
    const container = screen.getByTestId('file-changes-review-diff-lines')
    const tree = screen.getByTestId('pierre-file-tree')
    await waitFor(() =>
      expect(tree.shadowRoot?.querySelector('button[aria-label="beta.ts"]')).toBeTruthy()
    )

    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      fireEvent.click(tree.shadowRoot?.querySelector('button[aria-label="beta.ts"]') as HTMLElement)
      fireEvent.wheel(container, { deltaY: 100 })
      act(() => vi.advanceTimersByTime(50))
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test.each(['refresh', 'unmount'])('stops an active file jump on %s', async action => {
    const { rerender, unmount } = render(
      <FileChangesReviewPanel loading={false} diff={twoFileDiff} />
    )
    const container = screen.getByTestId('file-changes-review-diff-lines')
    const tree = screen.getByTestId('pierre-file-tree')
    await waitFor(() =>
      expect(tree.shadowRoot?.querySelector('button[aria-label="beta.ts"]')).toBeTruthy()
    )
    fireEvent.click(tree.shadowRoot?.querySelector('button[aria-label="beta.ts"]') as HTMLElement)
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
      })
    )
    container.scrollTop = 120
    container.scrollLeft = 30
    const stopScroll = vi.fn()
    container.scrollTo = stopScroll

    if (action === 'refresh') {
      rerender(<FileChangesReviewPanel loading diff={twoFileDiff} />)
    } else {
      unmount()
    }

    expect(stopScroll).toHaveBeenCalledWith({ top: 120, left: 30, behavior: 'instant' })
  })

  test('uses the application dark theme for review diffs', async () => {
    document.documentElement.dataset.theme = 'dark'

    render(<FileChangesReviewPanel loading={false} diff={twoFileDiff} />)

    expect(screen.getByTestId('file-changes-review-panel')).toHaveAttribute('data-theme', 'dark')
    expect(screen.getAllByTestId('file-changes-review-file-diff-body')[0]).toHaveAttribute(
      'data-theme',
      'dark'
    )
    await waitFor(() => expect(getRenderedDiffText()).toContain('new alpha'))
  })

  test('keeps every changed file diff visible when a file is selected', async () => {
    render(
      <FileChangesReviewPanel
        loading={false}
        diff={twoFileDiff}
        branchName="feature/change-set"
        targetBranchName="origin/main"
      />
    )

    const toolbar = screen.getByTestId('file-changes-review-toolbar')
    expect(within(toolbar).getByText(/Branch|分支/)).toBeInTheDocument()
    expect(within(toolbar).getByText('+2')).toBeInTheDocument()
    expect(within(toolbar).getByText('-2')).toBeInTheDocument()
    expect(within(toolbar).getByText('feature/change-set')).toBeInTheDocument()
    expect(within(toolbar).getByText('origin/main')).toBeInTheDocument()

    expect(screen.getByTestId('pierre-file-tree')).toBeInTheDocument()
    await waitFor(() => {
      const diffText = getRenderedDiffText()
      expect(diffText).toContain('new alpha')
      expect(diffText).toContain('new beta')
    })

    const fileToggles = screen.getAllByTestId('file-changes-review-file-diff-toggle')
    expect(fileToggles).toHaveLength(2)
    expect(fileToggles[0]).toHaveTextContent('src/alpha.ts')
    expect(fileToggles[1]).toHaveTextContent('src/beta.ts')

    fireEvent.click(fileToggles[0])
    expect(fileToggles[0]).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      const diffText = getRenderedDiffText()
      expect(diffText).not.toContain('new alpha')
      expect(diffText).toContain('new beta')
    })

    fireEvent.click(fileToggles[0])
    expect(fileToggles[0]).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      const diffText = getRenderedDiffText()
      expect(diffText).toContain('new alpha')
      expect(diffText).toContain('new beta')
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

  test('orders diff sections exactly like the file tree regardless of patch order', async () => {
    const paths = [
      'README.md',
      'src/file-10.ts',
      'src/z.ts',
      'src/nested/change.ts',
      'src/file-2.ts',
      'src/a.ts',
    ]
    const patch = paths
      .map(path =>
        [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n')
      )
      .join('\n')
    render(<FileChangesReviewPanel loading={false} diff={patch} />)

    const expected = [
      'src/nested/change.ts',
      'src/a.ts',
      'src/file-2.ts',
      'src/file-10.ts',
      'src/z.ts',
      'README.md',
    ]
    await waitFor(() => {
      const treeFiles = screen
        .getByTestId('pierre-file-tree')
        .shadowRoot?.querySelectorAll('[data-item-type="file"]')
      expect(Array.from(treeFiles ?? [], item => item.getAttribute('data-item-path'))).toEqual(
        expected
      )
    })
    expect(
      screen
        .getAllByTestId('file-changes-review-file-diff-section')
        .map(section => section.dataset.reviewPath)
    ).toEqual(expected)
  })

  test('keeps large diffs in one continuous list when focusing another file', async () => {
    const { rerender } = render(
      <FileChangesReviewPanel
        loading={false}
        diff={largeDiff}
        reviewTitle="上轮对话"
        defaultFileTreeVisible={false}
      />
    )

    expect(screen.getByTestId('file-changes-review-toolbar')).toHaveTextContent('上轮对话')
    expect(screen.getByTestId('file-changes-review-file-tree')).not.toBeVisible()
    expect(screen.getByTestId('toggle-file-tree-button')).toHaveAttribute('aria-pressed', 'false')

    const diff = screen.getByTestId('file-changes-review-diff')
    await waitFor(() => {
      expect(diff).toBeInTheDocument()
      expect(getRenderedDiffText()).toContain('new 1')
      expect(getRenderedDiffText()).toContain('new 2')
      expect(getRenderedDiffText()).toContain('new 13')
    })
    const sections = screen.getAllByTestId('file-changes-review-file-diff-section')
    expect(sections).toHaveLength(13)

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
      expect(getRenderedDiffText()).toContain('new 2')
      expect(getRenderedDiffText()).toContain('new 13')
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(sections[12])
    })
  })

  test('keeps the next file available after a diff with more than 700 lines', async () => {
    const longDiff = [
      'diff --git a/src/long.ts b/src/long.ts',
      '--- a/src/long.ts',
      '+++ b/src/long.ts',
      '@@ -1,701 +1,701 @@',
      ...Array.from({ length: 701 }, (_, index) => `-old line ${index}`),
      ...Array.from({ length: 701 }, (_, index) => `+new line ${index}`),
      twoFileDiff,
    ].join('\n')

    render(<FileChangesReviewPanel loading={false} diff={longDiff} />)

    expect(screen.getAllByTestId('file-changes-review-file-diff-section')).toHaveLength(3)
    await waitFor(() => {
      expect(getRenderedDiffText()).toContain('new line 700')
      expect(getRenderedDiffText()).toContain('new alpha')
      expect(getRenderedDiffText()).toContain('new beta')
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
    expect(screen.getByTestId('file-changes-review-file-tree')).toBeInTheDocument()

    const searchInput = screen.getByTestId('file-changes-review-file-search-input')
    await userEvent.type(searchInput, 'alpha')
    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    expect(screen.getByTestId('file-changes-review-file-tree')).not.toBeVisible()
    await userEvent.click(screen.getByTestId('toggle-file-tree-button'))
    expect(screen.getByTestId('file-changes-review-file-tree')).toBeVisible()
    expect(searchInput).toHaveValue('alpha')

    await userEvent.click(screen.getByTestId('toggle-diff-style-button'))
    expect(screen.getByTestId('file-changes-review-diff-lines')).toHaveAttribute(
      'data-diff-style',
      'split'
    )

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

  test('positions the requested file and opens its source location', async () => {
    const onOpenSourceFile = vi.fn()

    render(
      <FileChangesReviewPanel
        loading={false}
        diff={twoFileDiff}
        focusFilePath="src/beta.ts"
        onOpenSourceFile={onOpenSourceFile}
      />
    )

    const betaSection = screen
      .getAllByTestId('file-changes-review-file-diff-section')
      .find(section => section.getAttribute('data-review-path') === 'src/beta.ts')
    expect(betaSection).toBeDefined()
    await waitFor(() =>
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(betaSection)
    )

    await userEvent.click(
      within(betaSection as HTMLElement).getByTestId('file-changes-review-open-source-button')
    )
    expect(onOpenSourceFile).toHaveBeenCalledWith('src/beta.ts', 1, 1)
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

  test('applies only the selected hunk', async () => {
    const onApplyPatch = vi.fn().mockResolvedValue(undefined)

    render(
      <FileChangesReviewPanel
        loading={false}
        diff={twoFileDiff}
        reviewMode="unstaged"
        onApplyPatch={onApplyPatch}
      />
    )

    await userEvent.click(screen.getAllByTestId('file-changes-review-stage-hunk-button')[0])

    expect(onApplyPatch).toHaveBeenCalledWith(
      'stage',
      expect.stringContaining('diff --git a/src/alpha.ts b/src/alpha.ts')
    )
    expect(onApplyPatch.mock.calls[0]?.[1]).not.toContain('diff --git a/src/beta.ts b/src/beta.ts')
  })
})
