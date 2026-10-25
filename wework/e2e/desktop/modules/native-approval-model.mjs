export function isNativeApprovalReviewRequest(body) {
  const fields = body.text?.format?.schema?.properties
  return Boolean(
    fields?.risk_level &&
    fields?.user_authorization &&
    fields?.rationale &&
    fields?.outcome?.enum?.includes('allow') &&
    fields.outcome.enum.includes('deny')
  )
}

// Only the model is scripted. Native review routing, approval and tool execution
// remain real. Security scenarios supply their own explicit allow/deny verdicts.
export async function nativeApprovalModelResponse(body, scenario) {
  if (!isNativeApprovalReviewRequest(body)) return null
  const verdict = scenario?.reviewApproval
    ? await scenario.reviewApproval(body)
    : {
        risk_level: 'low',
        user_authorization: 'high',
        outcome: 'allow',
        rationale: 'Execute the action scripted by this isolated E2E fixture.',
      }
  if (!['allow', 'deny'].includes(verdict?.outcome)) {
    throw new Error('Native review fixture must provide an explicit outcome')
  }
  console.log(`[desktop-e2e-model] native approval review outcome=${verdict.outcome}`)
  return JSON.stringify(verdict)
}
