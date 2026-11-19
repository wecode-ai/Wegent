import { collectCiRun } from './ci-run.js'

export function changeRequestState(platform, url, data, sha) {
  return {
    kind: 'change_request',
    provider: platform,
    topicId: url,
    observedAt: new Date().toISOString(),
    data:
      platform === 'github'
        ? data
        : {
            iid: data.iid,
            web_url: data.web_url,
            title: data.title,
            state: data.state,
            draft: data.draft,
            merged_at: data.merged_at,
            updated_at: data.updated_at,
            source_branch: data.source_branch,
            sha,
            head_pipeline: data.head_pipeline?.sha === sha ? data.head_pipeline : undefined,
            observedPipeline: data.head_pipeline,
            detailed_merge_status: data.detailed_merge_status,
            has_conflicts: data.has_conflicts,
          },
  }
}

export function createTrackedCollector(helpers) {
  return async function collectTracked(ctx, platform, source, next) {
    const {
      parseProfile,
      invalid,
      fingerprint,
      objectVersion,
      stableValue,
      renderEvent,
      canonicalCommentId,
    } = helpers
    const targets = Object.values(next.tracked)
    const target = targets[next.trackIndex ?? 0]
    if (!target) {
      if (next.openChanges?.phase === 'compare') {
        next.tracked = Object.fromEntries(
          Object.entries(next.tracked).filter(
            ([, target]) => next.selectionSignature || !target.finished
          )
        )
        next.trackIndex = 0
        next.trackStep = 0
        next.page = 1
        if (next.openChanges.complete) delete next.openChanges.phase
        else next.openChanges.phase = 'discover'
        return { events: [], nextCheckpoint: next, hasMore: true }
      }
      next.tracked = Object.fromEntries(
        Object.entries(next.tracked).filter(
          ([, target]) => next.selectionSignature || !target.finished
        )
      )
      next.after = next.until
      delete next.until
      next.stream = 0
      if (source.transport === 'cli') next.activityComplete = false
      next.page = 1
      next.trackIndex = 0
      next.trackStep = 0
      next.nextCheckAt = Date.now() + Math.max(60, next.pollIntervalSeconds ?? 60) * 1000
      const cutoff = Date.now() - 30 * 86400000
      const active = Object.keys(next.tracked).map(url => `tracked:${url}:`)
      next.seen = Object.fromEntries(
        Object.entries(next.seen).filter(
          ([key, value]) =>
            key.startsWith('activity:') ||
            active.some(prefix => key.startsWith(prefix)) ||
            Date.parse(value.at) >= cutoff
        )
      )
      return { events: [], nextCheckpoint: next, hasMore: false }
    }
    if (['workflow_run', 'pipeline'].includes(target.entityKind))
      return collectCiRun(
        ctx,
        source,
        next,
        { ...target, platform },
        {
          parseProfile,
          invalid,
          fingerprint,
          stableValue,
        }
      )
    const step = next.trackStep ?? 0
    const steps = target.entityKind === 'change_request' ? 4 : 2
    const operation =
      step === 0 ? 'object' : step === 1 ? 'comments' : step === 2 ? 'checks' : 'api'
    const extra =
      step === 3
        ? {
            path:
              platform === 'github'
                ? `pulls/${target.number}/reviews`
                : `merge_requests/${target.number}/approvals`,
          }
        : {}
    let response
    try {
      response = await ctx.git.read({
        ...target,
        ...parseProfile(source.profile),
        profile: source.profile,
        operation,
        page: next.page ?? 1,
        sha: target.sha,
        ...extra,
      })
    } catch (error) {
      if (!['git_not_found', 'git_permission_denied'].includes(error?.code)) throw error
      if (step === 0) {
        if (target.entityKind === 'change_request' && source.monitoredObjects) {
          next.resourceStates ??= {}
          const previous = next.resourceStates[target.url]
          next.resourceStates[target.url] = {
            kind: 'change_request',
            provider: platform,
            topicId: target.url,
            observedAt: previous?.observedAt ?? new Date().toISOString(),
            data: previous?.data ?? {},
            errorCode: error.code,
          }
        }
        next.tracked[target.url].finished = true
        next.trackIndex = (next.trackIndex ?? 0) + 1
        next.trackStep = 0
        next.page = 1
      } else advanceTracked(next, steps)
      return {
        events: [],
        nextCheckpoint: next,
        hasMore: true,
        resourceStates: Object.values(next.resourceStates ?? {}),
      }
    }
    const stateEvents = []
    if (step === 0) {
      next.tracked[target.url].sha =
        response.data.head?.sha ?? response.data.sha ?? response.data.diff_refs?.head_sha
      if (response.data.state === 'closed' || response.data.state === 'merged')
        next.tracked[target.url].finished = true
      else delete next.tracked[target.url].finished
      if (target.entityKind === 'change_request' && source.monitoredObjects) {
        const data =
          platform === 'github'
            ? (
                await ctx.git.read({
                  ...target,
                  ...parseProfile(source.profile),
                  profile: source.profile,
                  operation: 'change_request_status',
                })
              ).data
            : response.data
        const url = data.url ?? data.web_url
        const sha = data.headRefOid ?? data.sha ?? data.diff_refs?.head_sha
        if (url !== target.url || (sha && sha !== next.tracked[target.url].sha))
          throw invalid('Observed change request identity or revision changed during collection')
        const previousState = next.resourceStates?.[target.url]
        next.resourceStates ??= {}
        next.resourceStates[target.url] = changeRequestState(platform, target.url, data, sha)
        const projected = next.resourceStates[target.url]
        const sampleCurrentStatus = source.observeCurrentStatus === true
        if (
          sampleCurrentStatus ||
          (previousState &&
            fingerprint(stableValue(previousState.data)) !==
              fingerprint(stableValue(projected.data)))
        ) {
          // Each fresh read is eligible for consumers activated since the previous poll.
          if (sampleCurrentStatus) next.statusSample = (next.statusSample ?? 0) + 1
          const version = objectVersion(
            platform,
            source,
            target.repository,
            sampleCurrentStatus ? 'change_request_status_observation' : 'change_request_state',
            sampleCurrentStatus
              ? [projected.observedAt, next.statusSample, projected.data]
              : projected.data,
            target.number
          )
          stateEvents.push({
            id: `${version.objectId}:${version.version}`,
            ...version,
            eventType: 'git.event',
            at: projected.observedAt,
            topicId: target.url,
            text: `${target.url}: change request status updated`,
            external: {
              platform,
              eventType: 'tracked.status',
              entityKind: 'change_request',
              objectKind: 'change_request_state',
              headSha: sha,
              url: target.url,
              payload: {
                ...projected.data,
                conclusion: String(
                  projected.data.statusCheckRollup?.state ??
                    projected.data.head_pipeline?.status ??
                    ''
                ).toLowerCase(),
              },
            },
          })
        }
      }
    }
    const rows = Array.isArray(response.data)
      ? response.data
      : (response.data.check_runs ?? [response.data])
    const events = stateEvents
    for (const row of rows) {
      const sourceAt = row.updated_at ?? row.completed_at ?? row.submitted_at ?? row.created_at
      const credibleTime = Number.isFinite(Date.parse(sourceAt))
      const at = credibleTime ? sourceAt : new Date().toISOString()
      const checkSha = row.head_sha ?? row.sha
      if (step === 2 && checkSha && target.sha && checkSha !== target.sha) continue
      const key = `tracked:${target.url}:${step}:${row.id ?? 'state'}`
      const digest = fingerprint(row)
      if (next.seen[key]?.digest === digest) continue
      if (target.baseline) {
        next.seen[key] = { digest, at }
        if (!credibleTime || Date.parse(sourceAt) < Date.parse(source.enabledAfter)) continue
      } else {
        if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(source.enabledAfter))
          continue
        next.seen[key] = { digest, at }
      }
      events.push({
        id:
          step === 1
            ? (canonicalCommentId(platform, source, target.repository, row) ??
              `${platform}:${key}:${digest}`)
            : `${platform}:${key}:${digest}`,
        ...objectVersion(
          platform,
          source,
          target.repository,
          step === 1
            ? 'comment'
            : step === 2
              ? platform === 'github'
                ? 'check_run'
                : 'pipeline'
              : step === 0
                ? target.entityKind
                : 'review',
          row,
          step === 0 ? target.number : (row.id ?? target.number)
        ),
        eventType: 'git.event',
        at,
        topicId: target.url,
        senderId: String(row.user?.id ?? row.author?.id ?? ''),
        text: renderEvent(platform, target.repository, `tracked.${operation}`, row),
        external: {
          platform,
          ...parseProfile(source.profile),
          eventType: `tracked.${operation}`,
          repositoryPath: target.repository,
          entityKind: target.entityKind,
          entityId: target.number,
          url: target.url,
          headSha: row.head_sha ?? row.sha ?? target.sha,
          objectKind: step === 1 ? 'comment' : operation,
          objectUrl: row.html_url ?? row.web_url,
          objectVersion: row.updated_at ?? row.created_at,
          timestampBasis: credibleTime ? 'source' : 'observed_change',
          payload: row,
        },
      })
    }
    if (rows.length === 100) next.page = (next.page ?? 1) + 1
    else advanceTracked(next, steps)
    return {
      events,
      nextCheckpoint: next,
      hasMore: true,
      resourceStates: Object.values(next.resourceStates ?? {}),
    }
  }
}

function advanceTracked(next, steps) {
  next.page = 1
  const target = Object.values(next.tracked)[next.trackIndex ?? 0]
  next.trackStep = (next.trackStep ?? 0) + (target?.baseline ? 2 : 1)
  if (next.trackStep >= steps) {
    if (target) delete target.baseline
    next.trackIndex = (next.trackIndex ?? 0) + 1
    next.trackStep = 0
  }
}
