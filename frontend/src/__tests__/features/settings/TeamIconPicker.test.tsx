// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { TeamIconPicker } from '@/features/settings/components/teams/TeamIconPicker'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('TeamIconPicker', () => {
  it('uploads and selects a custom image', async () => {
    const onChange = jest.fn()
    const onUploadImage = jest.fn().mockResolvedValue('/api/resource-library/assets/team-icons/12')

    render(<TeamIconPicker value={null} onChange={onChange} onUploadImage={onUploadImage} />)

    fireEvent.click(screen.getByTestId('team-icon-picker-trigger'))
    const file = new File(['image'], 'team.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('team-icon-image-input'), {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(onUploadImage).toHaveBeenCalledWith(file)
      expect(onChange).toHaveBeenCalledWith('/api/resource-library/assets/team-icons/12')
    })
  })

  it('renders and removes a custom image', () => {
    const onChange = jest.fn()

    render(
      <TeamIconPicker
        value="/api/resource-library/assets/team-icons/12"
        onChange={onChange}
        onUploadImage={jest.fn()}
      />
    )

    expect(screen.getByTestId('team-icon-picker-trigger').querySelector('img')).toHaveAttribute(
      'src',
      '/api/resource-library/assets/team-icons/12'
    )
    fireEvent.click(screen.getByTestId('team-icon-picker-trigger'))
    fireEvent.click(screen.getByTestId('team-icon-remove-button'))

    expect(onChange).toHaveBeenCalledWith(null)
  })
})
