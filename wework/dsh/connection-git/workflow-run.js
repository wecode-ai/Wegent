export async function readWorkflowRun(ctx, target, { parseProfile, invalid }) {
  const { instance } = parseProfile(target.profile)
  const response = await ctx.git.read({
    ...parseProfile(target.profile),
    profile: target.profile,
    repository: target.repository,
    operation: 'api',
    path: `actions/runs/${target.number}`,
  })
  const data = response.data
  const url = `${instance}/${target.repository}/actions/runs/${target.number}`
  if (
    data?.id !== target.number ||
    data.html_url !== url ||
    data.repository?.full_name !== target.repository ||
    !/^[a-fA-F0-9]{40}$/.test(data.head_sha ?? '') ||
    !Number.isSafeInteger(data.run_attempt) ||
    data.run_attempt < 1 ||
    typeof data.status !== 'string' ||
    response.profile !== target.profile
  )
    throw invalid('Observed workflow run identity or account changed')
  return response
}

export async function collectWorkflowRun(ctx, source, next, target, helpers) {
  next.resourceStates ??= {}
  const previous = next.resourceStates[target.url]
  let data
  try {
    data = (await readWorkflowRun(ctx, { ...target, profile: source.profile }, helpers)).data
  } catch (error) {
    if (!['git_not_found', 'git_permission_denied'].includes(error?.code)) throw error
    next.resourceStates[target.url] = {
      kind: 'workflow_run',
      provider: 'github',
      topicId: target.url,
      observedAt: previous?.observedAt ?? new Date().toISOString(),
      data: previous?.data ?? {},
      errorCode: error.code,
    }
    return advance(next)
  }
  const observedAt = new Date().toISOString()
  next.resourceStates[target.url] = {
    kind: 'workflow_run',
    provider: 'github',
    topicId: target.url,
    observedAt,
    data,
  }
  const version = helpers.fingerprint(helpers.stableValue(data))
  const key = `tracked:${target.url}:workflow_run`
  const old = next.seen[key]
  next.seen[key] = { digest: version, at: observedAt }
  // Emit a terminal first observation too: completion can race subscription initialization.
  const changed = old ? old.digest !== version : data.status === 'completed'
  const objectId = helpers.fingerprint([source.profile, source.id, target.url])
  const events = changed
    ? [
        {
          id: `${objectId}:${version}`,
          objectId,
          version,
          eventType: 'git.event',
          at: observedAt,
          topicId: target.url,
          text: `${target.url}: workflow run ${data.status} (${data.conclusion ?? 'pending'})`,
          external: {
            platform: 'github',
            eventType: 'tracked.workflow_run',
            entityKind: 'workflow_run',
            entityId: target.number,
            repositoryPath: target.repository,
            url: target.url,
            headSha: data.head_sha,
            payload: data,
          },
        },
      ]
    : []
  return advance(next, events)
}

function advance(next, events = []) {
  const target = Object.values(next.tracked)[next.trackIndex ?? 0]
  if (target) delete target.baseline
  next.trackIndex = (next.trackIndex ?? 0) + 1
  next.trackStep = 0
  next.page = 1
  return {
    events,
    nextCheckpoint: next,
    hasMore: true,
    resourceStates: Object.values(next.resourceStates),
  }
}
