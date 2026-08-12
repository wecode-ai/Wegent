import {
  RECOMMENDED_VIDEO_DURATION_SECONDS,
  exceedsRecommendedVideoDuration,
} from '@/features/knowledge/multimodal/utils/video-duration'

describe('exceedsRecommendedVideoDuration', () => {
  it('allows videos up to and including 30 minutes', () => {
    expect(exceedsRecommendedVideoDuration(RECOMMENDED_VIDEO_DURATION_SECONDS)).toBe(false)
  })

  it('warns for videos longer than 30 minutes', () => {
    expect(exceedsRecommendedVideoDuration(RECOMMENDED_VIDEO_DURATION_SECONDS + 1)).toBe(true)
  })

  it('does not warn when metadata is unavailable', () => {
    expect(exceedsRecommendedVideoDuration(Number.NaN)).toBe(false)
  })
})
