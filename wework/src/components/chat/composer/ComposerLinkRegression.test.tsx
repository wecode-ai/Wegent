import { fireEvent, render, screen } from '@testing-library/react'
import { createRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerTextarea } from './ComposerTextarea'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'

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

  test('opens link actions with the keyboard', () => {
    render(<Harness initialValue="http://example.com/page" />)
    fireEvent.keyDown(screen.getByTestId('composer-text-link'), { key: 'Enter' })
    expect(screen.getByTestId('link-edit-popover')).toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveValue('http://example.com/page')
  })
})
