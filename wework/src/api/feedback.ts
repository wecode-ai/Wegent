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

export function createFeedbackApi(feedbackUrl: string) {
  return {
    async submit(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
      const apiUrl = new URL(feedbackUrl, window.location.origin).toString()
      return invoke<FeedbackSubmitResult>('submit_feedback_bundle', {
        request: {
          apiUrl,
          stagingId: input.stagingId,
          title: input.title,
          description: input.description,
          context: input.context,
        },
      })
    },
  }
}
