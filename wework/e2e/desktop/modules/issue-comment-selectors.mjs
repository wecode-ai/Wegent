/** Scope the composer to its Issue, independently of the activity layout. */
export function issueCommentFormSelector(issueId) {
  return `[data-testid="cloud-todo-detail"]:has([data-testid="cloud-task-activity-${issueId}"]) [data-testid="task-comment-form"]`
}
