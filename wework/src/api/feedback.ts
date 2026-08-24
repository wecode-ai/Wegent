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

export function createFeedbackApi(feedbackUrl: string) {
  return {
    async submit(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
      void feedbackUrl
      void input
      throw new Error('Feedback bundle submission is not available in the Electron desktop host')
    },
  }
}
