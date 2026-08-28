// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { StoryboardVideoPreview } from '@wecode/features/video/storyboard/StoryboardVideoPreview'
import type { Storyboard } from '@wecode/features/video/storyboard/types'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

const storyboard: Storyboard = {
  id: 7,
  shot_id: 'SHOT_001',
  sequence_number: 0,
  duration_seconds: 5,
  visual: '晨光进入房间',
  location_id: 'SCENE_001',
  character_ids: [],
  prop_ids: [],
  mood: '温暖',
  camera_notes: '',
  generation_status: 2,
  risk_check_status: 0,
  image_pids: [],
  image_urls: [],
  video_clip: null,
  has_pending_video_generation: true,
  create_time: '2026-08-26T00:00:00',
  update_time: '2026-08-26T00:00:00',
}

describe('StoryboardVideoPreview', () => {
  it('shows a direct generation action without billing copy', () => {
    const onPlayClick = jest.fn()

    render(
      <StoryboardVideoPreview
        storyboard={storyboard}
        isVideoGenerating={false}
        isPendingVideoGeneration
        onPlayClick={onPlayClick}
      />
    )

    expect(screen.getByText('分镜视频待生成')).toBeInTheDocument()
    expect(screen.queryByText(/AI豆|预计消耗|扣费/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }))
    expect(onPlayClick).toHaveBeenCalledTimes(1)
  })
})
