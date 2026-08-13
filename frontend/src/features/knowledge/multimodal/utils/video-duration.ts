export const RECOMMENDED_VIDEO_DURATION_SECONDS = 30 * 60

const METADATA_LOAD_TIMEOUT_MS = 10_000

export function exceedsRecommendedVideoDuration(durationSeconds: number): boolean {
  return Number.isFinite(durationSeconds) && durationSeconds > RECOMMENDED_VIDEO_DURATION_SECONDS
}

export function readLocalVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false

    const finish = (duration: number | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
      resolve(duration)
    }

    const timeoutId = window.setTimeout(() => finish(null), METADATA_LOAD_TIMEOUT_MS)
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      finish(Number.isFinite(video.duration) ? video.duration : null)
    }
    video.onerror = () => finish(null)
    video.src = objectUrl
  })
}
