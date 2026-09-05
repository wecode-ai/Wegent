async function verifyBinaryAssetApproval({ github, context, core }) {
  const pullRequest = context.payload.pull_request
  if (!pullRequest) {
    throw new Error('Pull request context is required to verify binary asset approval')
  }

  const owner = context.repo.owner
  const repo = context.repo.repo
  const pullNumber = pullRequest.number
  const headSha = pullRequest.head.sha
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })

  const latestDecisiveReviewByUser = new Map()
  for (const review of reviews) {
    if (
      review.commit_id !== headSha ||
      !review.user?.login ||
      !['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)
    ) {
      continue
    }

    const current = latestDecisiveReviewByUser.get(review.user.login)
    if (!current || review.id > current.id) {
      latestDecisiveReviewByUser.set(review.user.login, review)
    }
  }

  const approvingUsers = [...latestDecisiveReviewByUser.values()]
    .filter((review) => review.state === 'APPROVED')
    .map((review) => review.user.login)

  for (const username of approvingUsers) {
    try {
      const response = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      })
      const isAdmin =
        response.data.permission === 'admin' ||
        response.data.user?.permissions?.admin === true

      if (isAdmin) {
        core.info(
          `Binary assets approved by repository administrator @${username} for ${headSha}`,
        )
        return
      }
    } catch (error) {
      if (error.status === 404) {
        core.info(`Reviewer @${username} is not a repository collaborator`)
        continue
      }
      throw error
    }
  }

  core.setFailed(
    `This pull request adds or modifies images or binary files. ` +
      `A repository administrator must approve the current head commit (${headSha}) before this check can pass.`,
  )
}

module.exports = verifyBinaryAssetApproval
