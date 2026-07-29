import { invoke } from '@tauri-apps/api/core'

export interface FeedbackSubmitResult {
  report_id: string
  project_id: string
  item_id: string
  created_by_user_id: number
  duplicate: boolean
}

export interface FeedbackSubmitInput {
  stagingId: string
  title: string
  description: string
  context: Record<string, unknown>
}

export function createFeedbackApi(apiBaseUrl: string, getToken: () => string | null) {
  return {
    async submit(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
      const accessToken = getToken()
      if (!accessToken) throw new Error('反馈通道异常，请联系开发者')
      const baseUrl = apiBaseUrl.replace(/\/+$/, '')
      const apiUrl = new URL(`${baseUrl}/v1/feedback`, window.location.origin).toString()
      return invoke<FeedbackSubmitResult>('submit_feedback_bundle', {
        request: {
          apiUrl,
          accessToken,
          stagingId: input.stagingId,
          title: input.title,
          description: input.description,
          context: input.context,
        },
      })
    },
  }
}
