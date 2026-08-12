// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import { ImageSizeSelector } from '@/features/tasks/components/selector/ImageSizeSelector'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('ImageSizeSelector', () => {
  it('shows ratio, resolution, and size in the trigger', () => {
    render(<ImageSizeSelector selectedSize="1024x1024" onSizeChange={jest.fn()} />)

    expect(screen.getByTestId('image-size-selector-trigger')).toHaveTextContent(
      '1:1 · 1K · 1024x1024'
    )
  })

  it('maps ratio and resolution selections to a concrete size', () => {
    const onSizeChange = jest.fn()
    const { rerender } = render(
      <ImageSizeSelector selectedSize="1024x1024" onSizeChange={onSizeChange} />
    )

    fireEvent.click(screen.getByTestId('image-size-selector-trigger'))
    fireEvent.click(screen.getByTestId('image-ratio-16-9'))
    expect(onSizeChange).toHaveBeenLastCalledWith('1280x720')

    rerender(<ImageSizeSelector selectedSize="1280x720" onSizeChange={onSizeChange} />)
    fireEvent.click(screen.getByTestId('image-resolution-2k'))
    expect(onSizeChange).toHaveBeenLastCalledWith('2848x1600')
  })

  it('uses theme-aware colors for the popover', () => {
    render(<ImageSizeSelector selectedSize="1024x1024" onSizeChange={jest.fn()} />)

    fireEvent.click(screen.getByTestId('image-size-selector-trigger'))

    expect(screen.getByTestId('image-size-selector-content')).toHaveClass(
      'bg-base',
      'text-text-primary'
    )
    expect(screen.getByTestId('image-size-value')).toHaveClass('bg-surface')
  })
})
