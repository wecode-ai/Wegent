// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AigcVideoPanel } from '@wecode/features/video/aigc_video/AigcVideoPanel'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

describe('AigcVideoPanel layout', () => {
  it('renders as an embedded panel and sends workflow actions', async () => {
    const onClose = jest.fn()
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)

    render(
      <AigcVideoPanel
        embedded
        onClose={onClose}
        panelProps={{
          title: '最后一战',
          previewText: '# 最后一战',
          buttons: [
            {
              button_id: 'generate-entities',
              button_name: '开始生成主体',
              button_type: 'chat',
            },
          ],
          onChatButtonClick,
        }}
      />
    )

    const panel = screen.getByTestId('aigc-video-panel')
    expect(panel).toHaveClass('h-full', 'w-full')
    expect(panel).not.toHaveClass('fixed')
    expect(screen.getByText('# 最后一战')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('aigc-video-panel-action-generate-entities'))
    })
    expect(onChatButtonClick).toHaveBeenCalledWith('开始生成主体')

    fireEvent.click(screen.getByTestId('aigc-video-panel-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
