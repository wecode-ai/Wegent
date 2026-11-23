export async function readCiRun(ctx, target, { parseProfile, invalid }) {
  const { instance } = parseProfile(target.profile)
  const github = target.platform === 'github'
  const response = await ctx.git.read({
    ...parseProfile(target.profile),
    profile: target.profile,
    repository: target.repository,
    operation: 'api',
    path: github ? `actions/runs/${target.number}` : `pipelines/${target.number}`,
  })
  const data = response.data
  const url = `${instance}/${target.repository}/${github ? 'actions/runs' : '-/pipelines'}/${target.number}`
  if (
    data?.id !== target.number ||
    (github ? data.html_url : data.web_url) !== url ||
    (github
      ? data.repository?.full_name !== target.repository ||
        String(data.repository?.id) !== String(target.repositoryId)
      : String(data.project_id) !== String(target.repositoryId)) ||
    !/^[a-fA-F0-9]{40}$/.test((github ? data.head_sha : data.sha) ?? '') ||
    (github && (!Number.isSafeInteger(data.run_attempt) || data.run_attempt < 1)) ||
    typeof data.status !== 'string' ||
    response.profile !== target.profile
  )
    throw invalid('Observed workflow run identity or account changed')
  return response
}

export async function collectCiRun(ctx, source, next, target, helpers) {
  const platform = target.platform
  const github = platform === 'github'
  const kind = github ? 'workflow_run' : 'pipeline'
  next.resourceStates ??= {}
  const previous = next.resourceStates[target.url]
  let data
  try {
    data = (
      await readCiRun(ctx, { ...target, repositoryId: source.id, profile: source.profile }, helpers)
    ).data
  } catch (error) {
    if (!['git_not_found', 'git_permission_denied'].includes(error?.code)) throw error
    next.resourceStates[target.url] = {
      kind,
      provider: platform,
      topicId: target.url,
      observedAt: previous?.observedAt ?? new Date().toISOString(),
      data: previous?.data ?? {},
      errorCode: error.code,
    }
    return advance(next)
  }
  const observedAt = new Date().toISOString()
  next.resourceStates[target.url] = {
    kind,
    provider: platform,
    topicId: target.url,
    observedAt,
    data,
  }
  const version = helpers.fingerprint(helpers.stableValue(data))
  const key = `tracked:${target.url}:${kind}`
  const old = next.seen[key]
  next.seen[key] = { digest: version, at: observedAt }
  // Emit a terminal first observation too: completion can race subscription initialization.
  const changed = old
    ? old.digest !== version
    : github
      ? data.status === 'completed'
      : ['success', 'failed', 'canceled', 'skipped', 'manual'].includes(data.status)
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
          text: `${target.url}: ${kind} ${data.status} (${data.conclusion ?? 'pending'})`,
          external: {
            platform,
            eventType: `tracked.${kind}`,
            entityKind: kind,
            entityId: target.number,
            repositoryPath: target.repository,
            url: target.url,
            headSha: data.head_sha ?? data.sha,
            payload: data,
          },
        },
      ]
    : []
  if (github && data.status !== 'completed') {
    const conflict = await collectWorkflowPrConflict(ctx, source, next, target, data, helpers)
    if (conflict) events.push(conflict)
  }
  return advance(next, events)
}

async function collectWorkflowPrConflict(ctx, source, next, target, run, helpers) {
  const candidates = (Array.isArray(run.pull_requests) ? run.pull_requests : []).filter(
    pr =>
      Number.isSafeInteger(pr?.number) &&
      pr.number > 0 &&
      String(pr.base?.repo?.id) === String(source.id) &&
      pr.head?.sha === run.head_sha
  )
  if (candidates.length !== 1) return
  const { number } = candidates[0]
  const profile = helpers.parseProfile(source.profile)
  const url = `${profile.instance}/${target.repository}/pull/${number}`
  let response
  try {
    response = await ctx.git.read({
      ...profile,
      profile: source.profile,
      repository: target.repository,
      entityKind: 'change_request',
      number,
      operation: 'change_request_status',
    })
  } catch (error) {
    if (!['git_not_found', 'git_permission_denied', 'git_status_unavailable'].includes(error?.code))
      throw error
    next.resourceStates[target.url].errorCode = error.code
    return
  }
  const pr = response.data
  if (response.profile !== source.profile || pr?.number !== number || pr.url !== url)
    throw helpers.invalid('Observed workflow pull request identity or account changed')
  if (
    pr.headRefOid !== run.head_sha ||
    pr.state !== 'OPEN' ||
    (pr.mergeable !== 'CONFLICTING' && pr.mergeStateStatus !== 'DIRTY')
  )
    return

  const key = `tracked:${target.url}:pr-conflict`
  const version = helpers.fingerprint([number, run.head_sha, run.run_attempt])
  if (next.seen[key]?.digest === version) return
  const at = next.resourceStates[target.url].observedAt
  next.seen[key] = { digest: version, at }
  const objectId = helpers.fingerprint([source.profile, source.id, target.url, number])
  return {
    id: `${objectId}:${version}`,
    objectId,
    version,
    eventType: 'git.event',
    at,
    topicId: target.url,
    text: `${url}: merge conflict while workflow ${target.url} is running`,
    external: {
      platform: 'github',
      eventType: 'tracked.workflow_run_pr_conflict',
      entityKind: 'change_request',
      entityId: number,
      repositoryPath: target.repository,
      url,
      headSha: run.head_sha,
      payload: { id: run.id, head_sha: run.head_sha, run_attempt: run.run_attempt },
    },
  }
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
