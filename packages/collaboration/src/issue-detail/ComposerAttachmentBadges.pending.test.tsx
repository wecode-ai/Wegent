// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ComposerAttachmentBadges } from './ComposerAttachmentBadges'
import type { AttachmentImageServices } from './AttachmentImageView'
import type { ComposerAttachment } from './ComposerAttachmentBadges'

it('releases an owned pending image URL when replaced by a caller-owned preview', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const create = vi.fn(() => 'blob:owned')
  const revoke = vi.fn()
  const NativeURL = URL
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static createObjectURL = create
      static revokeObjectURL = revoke
    }
  )
  const node = document.createElement('div')
  const root = createRoot(node)
  const file = new File(['image'], 'photo.png', { type: 'image/png' })
  function Harness({ previewUrl }: { previewUrl?: string }) {
    return (
      <ComposerAttachmentBadges
        attachments={[]}
        errors={new Map()}
        uploadingFiles={new Map([['photo.png', { file, previewUrl }]])}
        onRemoveAttachment={vi.fn()}
        imageServices={{} as AttachmentImageServices<ComposerAttachment>}
        labels={{
          removeAttachment: 'Remove',
          showText: 'Text',
          appshot: 'Shot',
          pastedText: 'Pasted',
          addingText: 'Adding',
        }}
      />
    )
  }
  try {
    await act(async () => root.render(<Harness />))
    expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:owned')
    expect(create).toHaveBeenCalledExactlyOnceWith(file)
    await act(async () => root.render(<Harness previewUrl="blob:borrowed" />))
    expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:borrowed')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned')
    await act(async () => root.unmount())
    expect(revoke).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})
