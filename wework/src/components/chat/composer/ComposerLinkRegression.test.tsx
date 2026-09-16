import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerTextarea } from './ComposerTextarea'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'
import { parseComposerLinks } from './composerLinks'
import { openExternalUrl } from '@/lib/external-links'

vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

function Harness({ initialValue = '' }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <ComposerTextarea
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      canSend
      placeholder="Message"
      rows={2}
      textareaRef={createRef()}
      className="min-h-12"
    />
  )
}

describe('ComposerTextarea GitHub inline link chips', () => {
  test.each([
    ['https://github.com/wecode-ai/Wegent', 'composer-link-chip'],
    ['https://example.com/page', 'composer-text-link'],
  ])('preserves edited delimiter labels for %s after draft restoration', (url, testId) => {
    const label = String.raw`!Docs [draft]\done]`
    const markdown = String.raw`[!Docs \[draft\]\\done\]](${url})`
    const view = render(<Harness initialValue={url} />)
    fireEvent.click(screen.getByTestId(testId))
    fireEvent.click(screen.getByTestId('link-edit-edit-text'))
    const input = screen.getByTestId('link-edit-text-input')
    fireEvent.change(input, { target: { value: label } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('chat-message-input')).toHaveValue(markdown)
    expect(screen.getByTestId(testId)).toHaveTextContent(label)
    const doc = createComposerDocument(markdown)
    expect(serializeComposerDocument(doc)).toBe(markdown)
    if (testId === 'composer-link-chip') {
      expect(doc.firstChild?.firstChild?.type.name).toBe('composer_link')
      expect(doc.firstChild?.firstChild?.attrs.label).toBe(label)
    }
    view.unmount()
    render(<Harness initialValue={markdown} />)
    expect(screen.getByTestId(testId)).toHaveTextContent(label)
    fireEvent.click(screen.getByTestId(testId))
    fireEvent.click(screen.getByTestId('link-edit-edit-url'))
    expect(screen.getByTestId('link-edit-url-input')).toHaveValue(url)
  })

  test.each(['http://example.com/file_name?q=a_b#section', 'https://example.com/page'])(
    'opens %s from the existing composer link popover without rewriting it',
    url => {
      vi.mocked(openExternalUrl).mockClear()
      const value = `访问 ${url} 后继续输入`
      render(<Harness initialValue={value} />)
      fireEvent.click(screen.getByTestId('composer-text-link'))
      expect(screen.getByTestId('link-edit-popover')).toBeInTheDocument()
      expect(openExternalUrl).not.toHaveBeenCalled()
      expect(screen.getByTestId('chat-message-input')).toHaveValue(value)
      fireEvent.click(screen.getByTestId('link-edit-open-link'))
      expect(openExternalUrl).toHaveBeenCalledWith(url)
      expect(screen.getByTestId('chat-message-input')).toHaveValue(value)
    }
  )

  test('opens link actions with the keyboard', () => {
    render(<Harness initialValue="http://example.com/page" />)
    fireEvent.keyDown(screen.getByTestId('composer-text-link'), { key: 'Enter' })
    expect(screen.getByTestId('link-edit-popover')).toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveValue('http://example.com/page')
  })

  test('edits the selected HTTP link without changing its neighboring link or Markdown', async () => {
    render(<Harness initialValue="**说明** http://example.com/a 和 http://example.com/b" />)
    fireEvent.click(screen.getAllByTestId('composer-text-link')[1])
    fireEvent.click(screen.getByTestId('link-edit-edit-text'))
    const input = screen.getByTestId('link-edit-text-input')
    fireEvent.change(input, { target: { value: '文档' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.queryByTestId('link-edit-text-input')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '**说明** http://example.com/a 和 [文档](http://example.com/b)'
    )
    fireEvent.click(screen.getAllByTestId('composer-text-link')[1])
    fireEvent.click(screen.getByTestId('link-edit-edit-url'))
    const urlInput = screen.getByTestId('link-edit-url-input')
    fireEvent.change(urlInput, { target: { value: 'https://example.com/new' } })
    fireEvent.keyDown(urlInput, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveValue(
        '**说明** http://example.com/a 和 [文档](https://example.com/new)'
      )
    )
  })

  test('does not make URLs in code clickable', () => {
    render(
      <Harness initialValue={'`http://example.com/a`\n\n```text\nhttp://example.com/b\n```'} />
    )
    expect(screen.queryByTestId('composer-text-link')).not.toBeInTheDocument()
  })

  const urls = [
    'https://github.com/wecode-ai/Wegent/',
    'https://github.com/wecode-ai/Wegent/actions/runs/30603861794/job/91072055935?pr=2348',
    'https://github.com/wecode-ai/Wegent/pull/2350',
  ]

  test.each(urls)('parses and models %s as a composer_link node', url => {
    const links = parseComposerLinks(`Check ${url}`)
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe(url)

    const doc = createComposerDocument(`Check ${url}`)
    const linkNodes: string[] = []
    doc.descendants(node => {
      if (node.type.name === 'composer_link') {
        linkNodes.push(String(node.attrs.label))
      }
      return true
    })
    expect(linkNodes).toHaveLength(1)
  })

  test.each(urls)('renders inline chip for %s', url => {
    render(<Harness initialValue={`Check ${url}`} />)
    const chip = screen.getByTestId('composer-link-chip')
    expect(chip).toHaveAttribute('data-composer-link-url', url)
    expect(chip).toHaveTextContent(/wecode-ai\/Wegent/)
  })

  test.each(urls)('clicking chip opens edit popover for %s', url => {
    render(<Harness initialValue={`Check ${url}`} />)
    const chip = screen.getByTestId('composer-link-chip')
    fireEvent.click(chip)
    expect(screen.getByTestId('link-edit-popover')).toBeInTheDocument()
  })

  test('shows the full URL for unknown GitHub sub-paths', () => {
    const url =
      'https://github.com/wecode-ai/Wegent/actions/runs/30603861794/job/91072055935?pr=2348'
    render(<Harness initialValue={`Check ${url}`} />)
    const chip = screen.getByTestId('composer-link-chip')
    expect(chip).toHaveTextContent(url)
    expect(chip).toHaveAttribute('data-composer-link-url', url)
  })

  test('edits display text while keeping the original URL behavior', async () => {
    const url = 'https://github.com/wecode-ai/Wegent/pull/2350'
    render(<Harness initialValue={`Check ${url}`} />)
    const chip = screen.getByTestId('composer-link-chip')
    fireEvent.click(chip)
    fireEvent.click(screen.getByTestId('link-edit-edit-text'))
    const input = screen.getByTestId('link-edit-text-input')
    fireEvent.change(input, { target: { value: '我的pr' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByTestId('link-edit-text-input')).not.toBeInTheDocument()
    })
    const editor = screen.getByTestId('chat-message-input')
    expect(editor).toHaveTextContent('Check 我的pr')
    expect(editor.innerHTML.includes(url)).toBe(true)
  })

  test('edits URL while keeping display text behavior', async () => {
    const url = 'https://github.com/wecode-ai/Wegent/pull/2350'
    const newUrl = 'https://github.com/wecode-ai/Wegent/pull/2400'
    render(<Harness initialValue={`Check ${url}`} />)
    const chip = screen.getByTestId('composer-link-chip')
    fireEvent.click(chip)
    fireEvent.click(screen.getByTestId('link-edit-edit-url'))
    const input = screen.getByTestId('link-edit-url-input')
    fireEvent.change(input, { target: { value: newUrl } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByTestId('link-edit-url-input')).not.toBeInTheDocument()
    })
    const editor = screen.getByTestId('chat-message-input')
    expect(editor).toHaveTextContent('Check wecode-ai/Wegent#2350')
    expect(editor.innerHTML.includes(newUrl)).toBe(true)
  })
})
