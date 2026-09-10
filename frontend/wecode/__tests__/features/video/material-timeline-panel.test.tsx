// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaterialTimelinePanel } from '@wecode/features/video/materials_to_video/MaterialTimelinePanel'
import { materialTimelineApi } from '@wecode/features/video/materials_to_video/api'

jest.mock('@wecode/features/video/materials_to_video/api', () => ({
  materialTimelineApi: {
    get: jest.fn(),
    update: jest.fn(),
    openInOpenCut: jest.fn(),
  },
}))

const toast = jest.fn()
const translate = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}))

const timelineResponse = {
  session_id: '25',
  total: 1,
  tracks: [
    {
      session_id: '25',
      task_id: 'plan-timeline-1',
      video_tracks: [
        {
          clip_id: 'clip-1',
          kind: 'image',
          source_path: '',
          source_window: { start: 0, end: 3000, duration: 3000 },
          timeline_window: { start: 0, end: 3000, duration: 3000 },
          playback_rate: 1,
        },
      ],
      subtitle_tracks: [],
      voiceover_tracks: [],
      bgm_tracks: [],
      source_audio_tracks: [],
      mg_tracks: [],
      sticker_tracks: [],
      transition_tracks: [],
    },
  ],
}

describe('MaterialTimelinePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(materialTimelineApi.get).mockResolvedValue(timelineResponse)
    jest.mocked(materialTimelineApi.update).mockResolvedValue({
      session_id: '25',
      task_id: 'plan-timeline-1',
      message: 'saved',
    })
    jest.mocked(materialTimelineApi.openInOpenCut).mockResolvedValue({
      open_url: 'https://timeline-cut.weibo.com/storycut/import?embed=wegent',
      artifact_id: 'plan-timeline-1',
    })
  })

  test('keeps save and render continuation as separate actions', async () => {
    const onContinue = jest.fn()
    render(<MaterialTimelinePanel sessionId="25" onContinue={onContinue} />)

    await screen.findByTestId('material-timeline-panel')
    fireEvent.click(screen.getByTestId('material-timeline-save'))

    await waitFor(() => expect(materialTimelineApi.update).toHaveBeenCalledTimes(1))
    expect(onContinue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('material-timeline-save-render'))

    await waitFor(() => expect(materialTimelineApi.update).toHaveBeenCalledTimes(2))
    expect(onContinue).toHaveBeenCalledWith('materialEditor.timeline.render')
  })

  test('refreshes after OpenCut saves and closes from its frame message', async () => {
    render(<MaterialTimelinePanel sessionId="25" />)

    await screen.findByTestId('material-timeline-panel')
    fireEvent.click(screen.getByTestId('material-timeline-open-opencut'))

    await waitFor(() =>
      expect(materialTimelineApi.openInOpenCut).toHaveBeenCalledWith('25', 'plan-timeline-1')
    )
    expect(await screen.findByTestId('material-timeline-opencut-frame')).toHaveAttribute(
      'src',
      'https://timeline-cut.weibo.com/storycut/import?embed=wegent&controlMode=host-v1&hostActions=save%2Csave-and-render%2Cclose'
    )

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://timeline-cut.weibo.com',
          source: (screen.getByTestId('material-timeline-opencut-frame') as HTMLIFrameElement)
            .contentWindow,
          data: { type: 'storycut:opencut-saved' },
        })
      )
    })

    await waitFor(() => expect(materialTimelineApi.get).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('material-timeline-opencut-frame')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://timeline-cut.weibo.com',
          source: (screen.getByTestId('material-timeline-opencut-frame') as HTMLIFrameElement)
            .contentWindow,
          data: { type: 'storycut:opencut-close' },
        })
      )
    })

    await waitFor(() =>
      expect(screen.queryByTestId('material-timeline-opencut-frame')).not.toBeInTheDocument()
    )
  })

  test('auto-opens OpenCut and closes its parent panel with the editor', async () => {
    const onOpenCutClose = jest.fn()
    render(<MaterialTimelinePanel sessionId="25" autoOpenOpenCut onOpenCutClose={onOpenCutClose} />)

    await screen.findByTestId('material-timeline-panel')
    await waitFor(() =>
      expect(materialTimelineApi.openInOpenCut).toHaveBeenCalledWith('25', 'plan-timeline-1')
    )
    expect(await screen.findByTestId('material-timeline-opencut-frame')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://timeline-cut.weibo.com',
          source: (screen.getByTestId('material-timeline-opencut-frame') as HTMLIFrameElement)
            .contentWindow,
          data: { type: 'storycut:opencut-close' },
        })
      )
    })

    await waitFor(() => expect(onOpenCutClose).toHaveBeenCalledTimes(1))
  })
})
