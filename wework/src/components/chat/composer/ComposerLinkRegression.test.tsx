import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerTextarea } from './ComposerTextarea'
import { createComposerDocument } from './composerProseMirrorModel'
import { parseComposerLinks } from './composerLinks'

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
