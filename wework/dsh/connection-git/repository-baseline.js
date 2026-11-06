// Repository discovery is checkpoint-owned and emits no historical business events.
export async function discoverOpenChanges(ctx, platform, source, checkpoint, helpers) {
  const { parseProfile, canonicalTopic, fingerprint, invalid } = helpers
  const next = structuredClone(checkpoint)
  next.tracked ??= {}
  next.seen ??= {}
  const discovery = (next.openChanges ??= { page: 1, complete: false })
  if (discovery.backlog && Object.keys(next.tracked).length < 100) discovery.page = 1
  delete discovery.backlog
  const identity = {
    ...parseProfile(source.profile),
    profile: source.profile,
    repository: source.name,
  }
  const repository = await ctx.git.read({ ...identity, operation: 'repository' })
  if (String(repository.data?.id) !== source.id) throw invalid('Repository identity changed')
  const response = await ctx.git.read({
    ...identity,
    operation: 'api',
    path:
      (platform === 'github'
        ? 'pulls?state=open&sort=updated&direction=desc'
        : 'merge_requests?state=opened&order_by=updated_at&sort=desc') +
      '&per_page=100&page=' +
      discovery.page,
  })
  if (!Array.isArray(response.data) || response.data.length > 100)
    throw invalid('Invalid open change-request discovery page')
  next.pollIntervalSeconds = Math.max(
    next.pollIntervalSeconds ?? 60,
    response.pollIntervalSeconds ?? 60
  )
  for (const row of response.data) {
    const number = row[platform === 'github' ? 'number' : 'iid']
    if (!Number.isSafeInteger(number) || number < 1)
      throw invalid('Open change request has no valid number')
    const url = canonicalTopic(platform, identity.instance, source.name, 'change_request', number)
    if (next.tracked[url]) continue
    if (Object.keys(next.tracked).length >= 100) {
      // Keep the unresolved page for a later pass; accepted objects still compare.
      discovery.backlog = true
      break
    }
    next.tracked[url] = {
      repository: source.name,
      number,
      entityKind: 'change_request',
      url,
      baseline: true,
    }
  }
  if (!discovery.backlog) {
    discovery.complete = response.data.length < 100
    if (!discovery.complete) discovery.page += 1
  }
  if (Object.keys(next.tracked).length) discovery.phase = 'compare'
  else delete discovery.phase
  const events = coverageEvents(platform, source, discovery, fingerprint)
  next.until ??= new Date().toISOString()
  next.trackIndex = 0
  next.trackStep = 0
  next.page = 1
  return { events, nextCheckpoint: next, hasMore: true }
}

export function coverageEvents(platform, source, discovery, fingerprint) {
  const status = discovery.backlog ? 'limited' : discovery.complete ? 'complete' : null
  if (
    !status ||
    status === discovery.coverageStatus ||
    (!discovery.coverageStatus && status === 'complete')
  )
    return []
  discovery.coverageStatus = status
  discovery.coverageRevision = (discovery.coverageRevision ?? 0) + 1
  const objectId = fingerprint([platform, source.profile, source.id, 'monitoring-coverage'])
  const version = fingerprint([status, discovery.coverageRevision])
  return [
    {
      id: 'git-monitoring:' + objectId + ':' + version,
      objectId,
      version,
      eventType: 'git.monitoring_coverage',
      at: new Date().toISOString(),
      topicId: 'git-monitoring:' + objectId,
      text:
        status === 'limited'
          ? `${source.name}: monitoring coverage is limited to the 100 registered open changes. More open changes remain on the saved discovery page. Registered changes continue to be checked; no unregistered change is claimed as covered. Review uncovered changes manually while waiting for capacity as tracked changes close.`
          : `${source.name}: open-change discovery completed and monitoring coverage has recovered.`,
      external: {
        platform,
        repositoryPath: source.name,
        eventType: 'monitoring.coverage',
        entityKind: 'monitoring_coverage',
        coverageStatus: status,
        payload: { limit: 100, discoveryPage: discovery.page },
      },
    },
  ]
}
