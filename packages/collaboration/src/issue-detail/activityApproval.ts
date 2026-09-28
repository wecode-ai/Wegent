export function canApproveIssueExecution(
  explicitlyAllowed: boolean | undefined,
  creatorId: string | number | null | undefined,
  userId: string | number | null | undefined
) {
  return (
    explicitlyAllowed === true ||
    (creatorId != null &&
      userId != null &&
      String(creatorId) !== '' &&
      String(creatorId) === String(userId))
  )
}
