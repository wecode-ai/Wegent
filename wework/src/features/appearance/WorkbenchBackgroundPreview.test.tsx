import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchBackgroundPreview } from './WorkbenchBackgroundPreview'

const { loadWorkbenchBackgroundImage } = vi.hoisted(() => ({
  loadWorkbenchBackgroundImage: vi.fn(),
}))

vi.mock('./backgroundImage', () => ({ loadWorkbenchBackgroundImage }))

function image(url: string) {
  return { url, release: vi.fn() }
}

function renderPreview(imagePath: string | null) {
  return render(
    <WorkbenchBackgroundPreview
      imagePath={imagePath}
      visibility={80}
      blur={10}
      testIdSuffix="-side"
    />
  )
}

describe('WorkbenchBackgroundPreview', () => {
  beforeEach(() => {
    loadWorkbenchBackgroundImage.mockReset()
  })

  test('shows the placeholder when the preview image cannot be decoded', async () => {
    loadWorkbenchBackgroundImage.mockResolvedValue(image('blob:broken'))

    const { container } = renderPreview('/backgrounds/broken.png')
    const preview = screen.getByTestId('appearance-background-preview-side')
    const previewImage = await waitFor(() => {
      const element = preview.querySelector('img')
      expect(element).not.toBeNull()
      return element as HTMLImageElement
    })

    expect(previewImage).toHaveAttribute('src', 'blob:broken')
    expect(previewImage).toHaveStyle({ filter: 'blur(10px)' })
    expect(container.querySelector('[data-testid$="-placeholder-side"]')).toBeNull()

    fireEvent.error(previewImage)

    await waitFor(() =>
      expect(screen.getByTestId('appearance-background-preview-placeholder-side')).toBeVisible()
    )
    expect(preview.querySelector('img')).toBeNull()
  })

  test('restores the preview image after switching from a broken path to a valid one', async () => {
    loadWorkbenchBackgroundImage
      .mockResolvedValueOnce(image('blob:broken'))
      .mockResolvedValueOnce(image('blob:valid'))

    const view = renderPreview('/backgrounds/broken.png')
    const preview = screen.getByTestId('appearance-background-preview-side')
    const brokenImage = await waitFor(() => {
      const element = preview.querySelector('img')
      expect(element).not.toBeNull()
      return element as HTMLImageElement
    })

    fireEvent.error(brokenImage)
    await screen.findByTestId('appearance-background-preview-placeholder-side')

    view.rerender(
      <WorkbenchBackgroundPreview
        imagePath="/backgrounds/valid.png"
        visibility={80}
        blur={10}
        testIdSuffix="-side"
      />
    )

    await waitFor(() => expect(preview.querySelector('img')).toHaveAttribute('src', 'blob:valid'))
    expect(screen.queryByTestId('appearance-background-preview-placeholder-side')).toBeNull()
    expect(preview.querySelectorAll('img')).toHaveLength(1)
  })

  test('keeps the visibility overlay on top of the loaded image', async () => {
    loadWorkbenchBackgroundImage.mockResolvedValue(image('blob:visible'))

    renderPreview('/backgrounds/visible.png')
    const preview = screen.getByTestId('appearance-background-preview-side')
    await waitFor(() => expect(preview.querySelector('img')).not.toBeNull())

    const overlay = preview.querySelector('img')?.nextElementSibling
    expect(overlay).not.toBeNull()
    expect(Number((overlay as HTMLElement).style.opacity)).toBeCloseTo(0.2)
  })
})
