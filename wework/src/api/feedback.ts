export interface FeedbackSubmitResult {
  report_id: string
  project_id: string
  item_id: string
  duplicate: boolean
}

export interface FeedbackSubmitInput {
  stagingId: string
  title: string
  description: string
  context: Record<string, unknown>
}

export function createFeedbackApi(feedbackUrl: string, getToken: () => string | null) {
  return {
    async submit(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
      const accessToken = getToken()
      if (!accessToken) throw new Error('反馈通道异常，请联系开发者')
      return invokeDesktopHost<FeedbackSubmitResult>('feedback.submitBundle', {
        request: {
          apiUrl: new URL(feedbackUrl, window.location.origin).toString(),
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
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
