// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AigcVideoPanel } from '@wecode/features/video/aigc_video/AigcVideoPanel'
import { scriptApi } from '@wecode/features/video/script/api'

jest.mock('@wecode/features/video/script/api', () => ({
  scriptApi: {
    getScript: jest.fn(),
    updateDraftScript: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'materialEditor.timeline.render' ? '渲染成片' : key),
  }),
}))

jest.mock('@wecode/features/video/materials_to_video/MaterialVideoPanel', () => ({
  MaterialVideoPanel: ({ onRender }: { onRender?: () => Promise<void> }) => (
    <button data-testid="test-material-save-render" onClick={onRender}>
      Save and render
    </button>
  ),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

describe('AigcVideoPanel layout', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends the normal editing render instruction from the timeline editor', async () => {
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    render(
      <AigcVideoPanel
        embedded
        onClose={jest.fn()}
        panelProps={{
          title: '视频剪辑',
          link: '/chat?taskId=137&openPanel=timeline&sessionId=137',
          onChatButtonClick,
        }}
      />
    )

    fireEvent.click(await screen.findByTestId('test-material-save-render'))

    expect(onChatButtonClick).toHaveBeenCalledWith('渲染成片')
  })

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

  it('loads the complete script instead of rendering the truncated card preview', async () => {
    const onClose = jest.fn()
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    jest.mocked(scriptApi.getScript).mockResolvedValue({
      script_id: 12,
      task_id: 3,
      title: '晨光里的温柔时刻',
      is_draft: true,
      draft_content: '# 晨光里的温柔时刻\n\n完整的第二幕与结尾内容',
    })

    render(
      <AigcVideoPanel
        embedded
        onClose={onClose}
        panelProps={{
          title: '晨光里的温柔时刻',
          link: '/chat?taskId=3&openPanel=script&scriptId=12',
          previewText: '# 晨光里的温柔时刻\n\n**旁...',
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

    expect(await screen.findByTestId('video-script-panel')).toBeInTheDocument()
    expect(scriptApi.getScript).toHaveBeenCalledWith(12, { shareToken: undefined })
    expect(screen.getByText(/完整的第二幕与结尾内容/)).toBeInTheDocument()
    expect(screen.queryByText(/旁\.\.\./)).not.toBeInTheDocument()
    expect(screen.getByTestId('script-full-content')).toHaveClass('sm:pl-[60px]')

    const action = screen.getByTestId('aigc-video-panel-action-generate-entities')
    expect(action).toHaveClass('w-full')
    fireEvent.click(action)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChatButtonClick).toHaveBeenCalledWith('开始生成主体')
  })

  it('loads shared scripts read-only and hides workflow actions', async () => {
    jest.mocked(scriptApi.getScript).mockResolvedValue({
      script_id: 24,
      task_id: 35,
      title: '共享剧本',
      is_draft: true,
      draft_content: '# 完整共享剧本',
    })

    render(
      <AigcVideoPanel
        embedded
        onClose={jest.fn()}
        panelProps={{
          title: '共享剧本',
          link: '/chat?taskId=35&openPanel=script&scriptId=24',
          shareToken: 'shared-token',
          buttons: [
            {
              button_id: 'generate-entities',
              button_name: '开始生成主体',
              button_type: 'chat',
            },
          ],
        }}
      />
    )

    expect(await screen.findByText('# 完整共享剧本')).toBeInTheDocument()
    expect(scriptApi.getScript).toHaveBeenCalledWith(24, { shareToken: 'shared-token' })
    expect(screen.queryByTestId('script-edit')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('aigc-video-panel-action-generate-entities')
    ).not.toBeInTheDocument()
  })
})
