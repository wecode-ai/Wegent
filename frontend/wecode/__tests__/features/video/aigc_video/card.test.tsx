// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CardBlock } from '@wegent/chat-core'
import { getCardComponent } from '@/features/cards/registry'
import {
  OPEN_TASK_RIGHT_PANEL_EVENT,
  type TaskRightPanelRequest,
} from '@/features/tasks/components/right-panel'
import AigcVideoCard from '@/../wecode/features/video/aigc_video/AigcVideoCard'
import type { AigcVideoPanelPayload } from '@/../wecode/features/video/aigc_video/AigcVideoPanel'
import { ShareTokenProvider } from '@/contexts/ShareTokenContext'
import '@/../wecode/features/video/cardRegistry'
import { materialTimelineApi } from '@wecode/features/video/materials_to_video/api'

jest.mock('@wecode/features/video/materials_to_video/api', () => ({
  materialTimelineApi: { openInOpenCut: jest.fn() },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function buildCard(overrides: Partial<CardBlock> = {}): CardBlock {
  return {
    id: 'card-1',
    type: 'card',
    status: 'done',
    card_id: 'card-1',
    card_type: 'video_director_generation',
    card_status: 'populated',
    card_data: {},
    card_preview_data: {},
    card_error: null,
    ...overrides,
  }
}

describe('AigcVideoCard', () => {
  it('renders short-video results without a redundant details entry', () => {
    render(
      <AigcVideoCard
        block={buildCard({
          card_type: 'video_short_generation',
          card_data: {
            video_url: 'https://f.video.weibocdn.com/result.mp4',
            link: 'https://wegent.test/chat?taskId=74&openPanel=timeline',
          },
        })}
      />
    )
    expect(screen.getByTestId('card-video-director-player')).toBeInTheDocument()
    expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
    expect(screen.queryByText('cards.video_director.viewDetails')).not.toBeInTheDocument()
  })

  it('opens the highlight timeline and explicitly requests rendering saved edits', async () => {
    jest.mocked(materialTimelineApi.openInOpenCut).mockResolvedValue({
      open_url: 'https://editor.test/import',
      artifact_id: 'timeline-1',
    })
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    render(
      <AigcVideoCard
        block={buildCard({
          card_type: 'video_short_generation',
          card_data: {
            video_url: 'https://f.video.weibocdn.com/highlight.mp4',
            link: 'https://wegent.test/chat?taskId=74&openPanel=timeline',
            editor_type: 'opencut',
            opencut: { session_id: '74', artifact_id: 'timeline-1' },
          },
        })}
        onChatButtonClick={onChatButtonClick}
      />
    )
    expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('highlight-card-render-saved')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('material-timeline-open-opencut'))
    await waitFor(() =>
      expect(materialTimelineApi.openInOpenCut).toHaveBeenCalledWith('74', 'timeline-1')
    )
    const frame = (await screen.findByTestId(
      'material-timeline-opencut-frame'
    )) as HTMLIFrameElement
    expect(new URL(frame.src).searchParams.get('controlMode')).toBe('host-v1')
    const post = jest.spyOn(frame.contentWindow!, 'postMessage')
    const message = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://editor.test',
            source: frame.contentWindow,
            data: { protocolVersion: 1, ...data },
          })
        )
      })
    expect(screen.getByTestId('opencut-host-save-render')).toBeDisabled()
    message({ type: 'storycut:opencut-ready', capabilities: ['save'] })
    message({ type: 'storycut:opencut-host-ready' })
    fireEvent.click(screen.getByTestId('opencut-host-save-render'))
    expect(onChatButtonClick).not.toHaveBeenCalled()
    const request = post.mock.calls.find(([data]) => data.type === 'storycut:host-save-request')![0]
    message({ type: 'storycut:opencut-save-result', requestId: request.requestId, ok: true })
    await waitFor(() =>
      expect(onChatButtonClick).toHaveBeenCalledWith('highlightActions.renderRequest')
    )
    await waitFor(() =>
      expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
    )
  })

  it.each(['pending', 'partial_ready', 'error'] as const)(
    'hides highlight actions while status is %s',
    cardStatus => {
      render(
        <AigcVideoCard
          block={buildCard({
            card_status: cardStatus,
            card_data: {
              editor_type: 'opencut',
              opencut: { session_id: '74', artifact_id: 'timeline-1' },
            },
          })}
        />
      )
      expect(screen.queryByTestId('highlight-card-actions')).not.toBeInTheDocument()
    }
  )

  it('does not offer editing on shared highlight cards', () => {
    render(
      <ShareTokenProvider shareToken="shared-token">
        <AigcVideoCard
          block={buildCard({
            card_data: {
              editor_type: 'opencut',
              opencut: { session_id: '74', artifact_id: 'timeline-1' },
            },
          })}
        />
      </ShareTokenProvider>
    )
    expect(screen.queryByTestId('highlight-card-actions')).not.toBeInTheDocument()
  })

  it.each([{}, { session_id: '74' }, { session_id: 74, artifact_id: 'timeline-1' }])(
    'ignores malformed editor metadata %j',
    opencut => {
      render(
        <AigcVideoCard block={buildCard({ card_data: { editor_type: 'opencut', opencut } })} />
      )
      expect(screen.queryByTestId('highlight-card-actions')).not.toBeInTheDocument()
    }
  )

  it('maps the internal legacy video card type to the unified renderer', () => {
    expect(getCardComponent('video_short_generation')).toBe(AigcVideoCard)
  })

  it('routes Weibo card media through the authenticated media proxies', () => {
    const videoUrl = 'https://f.video.weibocdn.com/o0/video.mp4?KID=expired'
    const coverUrl = 'https://wx1.sinaimg.cn/large/cover.jpg'
    const { rerender } = render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '一分钟成片',
            video_url: videoUrl,
            cover_url: coverUrl,
          },
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-player')).toHaveAttribute(
      'src',
      `/api/aigc-video/media/playback?video_url=${encodeURIComponent(videoUrl)}`
    )
    expect(screen.getByTestId('card-video-director-player')).toHaveAttribute(
      'poster',
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(coverUrl)}`
    )
    expect(screen.getByTestId('generated-video-player')).toBeInTheDocument()

    rerender(
      <AigcVideoCard
        block={buildCard({
          status: 'error',
          card_status: 'error',
          card_error: '生成失败',
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-error')).toHaveTextContent('生成失败')
  })

  it('opens the internal panel only for a validated workflow URL', () => {
    const handleOpen = jest.fn()
    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    const { rerender } = render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '星空信号',
            created_time: '2026-08-24T03:20:54',
            link: 'http://localhost:3000/chat?mode=video&taskId=10&openPanel=script&scriptId=5',
          },
        })}
      />
    )

    expect(screen.getByText('card.viewEdit')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('card-video-director-detail'))
    expect(handleOpen).toHaveBeenCalledTimes(1)
    const event = handleOpen.mock.calls[0][0] as CustomEvent<
      TaskRightPanelRequest<AigcVideoPanelPayload>
    >
    expect(event.detail).toMatchObject({
      panelType: 'aigc-video',
      panelProps: {
        title: '星空信号',
        fallbackTaskId: undefined,
        link: 'http://localhost:3000/chat?mode=video&taskId=10&openPanel=script&scriptId=5',
      },
    })

    rerender(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            link: 'javascript:alert(1)',
          },
        })}
      />
    )

    expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
    window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  })

  it('requests OpenCut auto-open when the timeline card is clicked', () => {
    const handleOpen = jest.fn()
    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '视频剪辑规划',
            link: 'http://localhost:3030/chat?taskId=53&openPanel=timeline',
          },
        })}
      />
    )

    fireEvent.click(screen.getByTestId('card-video-director-detail'))

    const event = handleOpen.mock.calls[0][0] as CustomEvent<
      TaskRightPanelRequest<AigcVideoPanelPayload>
    >
    expect(event.detail.panelProps.autoOpenOpenCut).toBe(true)
    window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  })

  it('requests OpenCut auto-open when a timeline card first becomes ready', () => {
    const handleOpen = jest.fn()
    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    const { rerender } = render(
      <AigcVideoCard
        block={buildCard({
          card_status: 'pending',
          card_data: {
            title: '视频剪辑规划',
            link: 'http://localhost:3030/chat?taskId=53&openPanel=timeline',
          },
        })}
      />
    )

    rerender(
      <AigcVideoCard
        block={buildCard({
          card_status: 'populated',
          card_data: {
            title: '视频剪辑规划',
            link: 'http://localhost:3030/chat?taskId=53&openPanel=timeline',
          },
        })}
      />
    )

    expect(handleOpen).toHaveBeenCalledTimes(1)
    const event = handleOpen.mock.calls[0][0] as CustomEvent<
      TaskRightPanelRequest<AigcVideoPanelPayload>
    >
    expect(event.detail.panelProps.autoOpenOpenCut).toBe(true)
    window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  })

  it.each(['partial_ready', 'populated'] as const)(
    'does not automatically open a highlight editor when the card becomes %s',
    cardStatus => {
      const handleOpen = jest.fn()
      window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
      const { rerender } = render(
        <AigcVideoCard
          block={buildCard({ card_type: 'video_short_generation', card_status: 'pending' })}
        />
      )

      rerender(
        <AigcVideoCard
          block={buildCard({
            card_type: 'video_short_generation',
            card_status: cardStatus,
            card_data: {
              title: '高光视频',
              link: 'http://localhost:3030/chat?taskId=74&openPanel=timeline',
              editor_type: 'opencut',
              opencut: { session_id: '74', artifact_id: 'timeline-1' },
            },
          })}
        />
      )

      expect(handleOpen).not.toHaveBeenCalled()
      expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
      expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
      expect(screen.queryByTestId('highlight-card-render-saved')).not.toBeInTheDocument()
      window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    }
  )

  it('passes the public task share token to the video panel', () => {
    const handleOpen = jest.fn()
    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    render(
      <ShareTokenProvider shareToken="shared-token">
        <AigcVideoCard
          block={buildCard({
            card_data: {
              title: '共享剧本',
              link: 'http://localhost:3030/chat?taskId=35&openPanel=script&scriptId=24',
            },
          })}
        />
      </ShareTokenProvider>
    )

    fireEvent.click(screen.getByTestId('card-video-director-detail'))

    const event = handleOpen.mock.calls[0][0] as CustomEvent<
      TaskRightPanelRequest<AigcVideoPanelPayload>
    >
    expect(event.detail.panelProps.shareToken).toBe('shared-token')
    window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  })

  it('sends the workflow action label back to the chat agent', async () => {
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '星空信号',
            buttons: [
              {
                button_id: 'generate-entities',
                button_name: '开始生成主体',
                button_type: 'chat',
              },
            ],
          },
        })}
        onChatButtonClick={onChatButtonClick}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('aigc-video-card-action-generate-entities'))
    })

    expect(onChatButtonClick).toHaveBeenCalledWith('开始生成主体')
  })

  it('opens persisted previews and adapts legacy content buttons without a link', async () => {
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    const handleOpen = jest.fn()
    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '最后一战',
            preview_type: 'script',
            preview_content: {
              text: '# 最后一战',
            },
            content: [
              {
                type: 'button',
                value: [
                  {
                    button_id: 'legacy-next',
                    button_name: '开始生成主体',
                    button_type: 'chat',
                  },
                ],
              },
            ],
          },
        })}
        onChatButtonClick={onChatButtonClick}
      />
    )

    fireEvent.click(screen.getByTestId('card-video-director-detail'))
    expect(handleOpen).toHaveBeenCalledTimes(1)
    const event = handleOpen.mock.calls[0][0] as CustomEvent<
      TaskRightPanelRequest<AigcVideoPanelPayload>
    >
    expect(event.detail.panelProps).toMatchObject({
      title: '最后一战',
      previewText: '# 最后一战',
      buttons: [
        {
          button_id: 'legacy-next',
          button_name: '开始生成主体',
          button_type: 'chat',
        },
      ],
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('aigc-video-card-action-legacy-next'))
    })
    expect(onChatButtonClick).toHaveBeenCalledWith('开始生成主体')
    window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  })
})
