import { createHash } from 'node:crypto'
import { createGitSourceReader } from './source-read.js'
import { discoverOpenChanges, coverageEvents } from './repository-baseline.js'
import {
  monitoringMetadata,
  validateMonitoringSource,
  monitoringCheckpoint,
} from './monitoring-selection.js'

export const GIT_PACKAGE = '@wegent/dsh-connection-git/'
const STREAMS = ['notifications', 'assigned', 'reviews']
const usesWebhook = source => source.kind === 'repository' && source.transport !== 'cli'

const invalid = message => Object.assign(new Error(message), { code: 'git_connection_invalid' })
const required = (value, field) => {
  if (typeof value[field] !== 'string' || !value[field]) throw invalid(`Missing ${field}`)
  return value[field]
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function parseProfile(profile) {
  let value
  try {
    value = JSON.parse(profile)
  } catch {
    throw invalid('Invalid Git account')
  }
  if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== 'string' || !v))
    throw invalid('Invalid Git account')
  return { instance: value[0], accountId: value[1] }
}

export function createProvider(platform) {
  const providerId = GIT_PACKAGE + platform
  return {
    readSource: createGitSourceReader(platform, parseProfile),
    async check() {
      // A GitLab instance is selected before checking its account; catalog reads
      // must not accidentally probe gitlab.com for an enterprise-only user.
      return { status: 'ready' }
    },
    async listResources(ctx, input) {
      let query
      try {
        query = JSON.parse(input.query)
      } catch {
        throw invalid('Select a Git instance')
      }
      const selection = monitoringMetadata(platform, query.monitoredObjects, {
        fingerprint,
        invalid,
      })
      if (
        selection &&
        (input.kind !== 'repository' ||
          typeof query.repository !== 'string' ||
          !query.repository.trim())
      )
        throw invalid('Choose an exact repository for selected-object monitoring')
      try {
        const identity = await ctx.git.read({ operation: 'identity', instance: query.instance })
        const profile = required(identity, 'profile')
        if (input.kind === 'personal')
          return {
            items: [
              {
                providerId,
                profile,
                kind: 'personal',
                transport: 'cli',
                id: 'personal',
                name: `${identity.login} · ${identity.instance}`,
              },
            ],
            hasMore: false,
          }
        if (input.kind !== 'repository') throw invalid('Unsupported Git resource')
        if (query.repository !== undefined) {
          if (typeof query.repository !== 'string' || !query.repository.trim())
            throw invalid('Choose an exact repository')
          const response = await ctx.git.read({
            operation: 'repository',
            profile,
            instance: identity.instance,
            repository: query.repository,
          })
          const row = response.data
          const name = required(row, platform === 'github' ? 'full_name' : 'path_with_namespace')
          if (
            name !== query.repository ||
            !['number', 'string'].includes(typeof row.id) ||
            !String(row.id)
          )
            throw invalid('Repository discovery identity changed')
          for (const object of selection?.monitoredObjects ?? []) {
            const details = await ctx.git.read({
              operation: 'object',
              profile,
              instance: identity.instance,
              repository: name,
              ...object,
            })
            if (
              details.data?.[platform === 'github' ? 'number' : 'iid'] !== object.number ||
              (platform === 'github' && object.entityKind === 'issue' && details.data.pull_request)
            )
              throw invalid('Selected object does not match this repository and object kind')
          }
          return {
            items: [
              {
                providerId,
                profile,
                kind: 'repository',
                transport: 'cli',
                id: String(row.id),
                name,
                ...(selection ?? {}),
              },
            ],
            hasMore: false,
          }
        }
        const page = Number(input.cursor ?? 1)
        if (!Number.isSafeInteger(page) || page < 1) throw invalid('Invalid page')
        const response = await ctx.git.read({
          operation: 'repositories',
          profile,
          instance: identity.instance,
          query: query.search ?? '',
          page,
        })
        if (!Array.isArray(response.data)) throw invalid('Invalid repository list')
        const rows = response.data.filter(
          row =>
            platform !== 'github' ||
            !query.search ||
            row.full_name.toLowerCase().includes(query.search.toLowerCase())
        )
        return {
          items: rows.map(row => ({
            providerId,
            profile,
            kind: 'repository',
            transport: 'cli',
            id: String(row.id),
            name: required(row, platform === 'github' ? 'full_name' : 'path_with_namespace'),
          })),
          hasMore: response.data.length === 100,
          nextCursor: String(page + 1),
        }
      } catch (error) {
        if (error.code !== 'connector_auth_required') throw error
        const target = await ctx.git.authTarget({ instance: query.instance })
        if (
          !['pluginKey', 'connectorSlug'].every(
            key => typeof target?.[key] === 'string' && target[key].trim()
          )
        )
          throw invalid('Native authorization identity is unavailable')
        return {
          items: [],
          hasMore: false,
          availability: {
            status: 'auth_required',
            authTarget: {
              pluginKey: target.pluginKey,
              connectorSlug: target.connectorSlug,
              ...(target.instance ? { instance: target.instance } : {}),
            },
          },
        }
      }
    },
    async validate(_ctx, source) {
      if (!['personal', 'repository'].includes(source.kind)) throw invalid('Invalid Git scope')
      parseProfile(required(source, 'profile'))
      if (source.kind === 'repository') {
        required(source, 'name')
        if (usesWebhook(source) && (!source.subscriptionId || !source.generation))
          throw invalid('Configure the repository webhook')
      }
      validateMonitoringSource(platform, source, { fingerprint, invalid })
      return source
    },
    async initialize(ctx, source) {
      const selection = validateMonitoringSource(platform, source, { fingerprint, invalid })
      if (selection)
        return monitoringCheckpoint(platform, source, selection, { canonicalTopic, parseProfile })
      const boundary = usesWebhook(source)
        ? (source.boundary ??
          (await ctx.git.inbox({
            operation: 'boundary',
            subscriptionId: source.subscriptionId,
            generation: source.generation,
            resumePending: source.resumePending === true,
          })))
        : undefined
      return {
        after: source.enabledAfter ?? new Date().toISOString(),
        stream: 0,
        page: 1,
        seen: {},
        tracked: {},
        sequence: boundary?.sequence ?? 0,
        ...(boundary ? { partition: boundary.partition } : {}),
      }
    },
    async collect(ctx, { source, checkpoint }) {
      const selection = validateMonitoringSource(platform, source, { fingerprint, invalid })
      if (selection && checkpoint.selectionSignature !== selection.collectionKey)
        checkpoint = monitoringCheckpoint(platform, source, selection, {
          canonicalTopic,
          parseProfile,
        })
      if (checkpoint.nextCheckAt && Date.now() < checkpoint.nextCheckAt)
        return { events: [], nextCheckpoint: checkpoint, hasMore: false }
      if (selection) {
        const next = structuredClone(checkpoint)
        const chosen = new Set(
          selection.monitoredObjects.map(object => object.entityKind + ':' + object.number)
        )
        if (
          Object.values(next.tracked ?? {}).some(
            target =>
              !chosen.has(target.entityKind + ':' + target.number) ||
              target.repository !== source.name ||
              target.url !==
                canonicalTopic(
                  platform,
                  parseProfile(source.profile).instance,
                  source.name,
                  target.entityKind,
                  target.number
                )
          )
        )
          throw invalid('Monitoring checkpoint contains an unselected object')
        if ((next.trackIndex ?? 0) === 0 && (next.trackStep ?? 0) === 0 && (next.page ?? 1) === 1) {
          const repository = await ctx.git.read({
            ...parseProfile(source.profile),
            profile: source.profile,
            repository: source.name,
            operation: 'repository',
          })
          if (String(repository.data?.id) !== source.id)
            throw invalid('Repository identity changed')
        }
        next.until ??= new Date().toISOString()
        return collectTracked(ctx, platform, source, next)
      }
      if (source.transport === 'cli') {
        if (
          source.kind === 'repository' &&
          !checkpoint.openChanges?.complete &&
          checkpoint.openChanges?.phase !== 'compare'
        )
          return discoverOpenChanges(ctx, platform, source, checkpoint, {
            parseProfile,
            canonicalTopic,
            fingerprint,
            invalid,
          })
        if (source.kind === 'repository' && checkpoint.openChanges?.phase === 'compare')
          return collectTracked(ctx, platform, source, structuredClone(checkpoint))
        if (!checkpoint.activityComplete) return collectActivity(ctx, platform, source, checkpoint)
        if (source.kind === 'repository')
          return collectTracked(ctx, platform, source, structuredClone(checkpoint))
      }
      if (usesWebhook(source)) {
        const { instance } = parseProfile(source.profile)
        const identityDue =
          !checkpoint.identityCheckedAt || Date.now() - checkpoint.identityCheckedAt >= 3600000
        if (identityDue) {
          const repository = await ctx.git.read({
            operation: 'repository',
            instance,
            profile: source.profile,
            repository: source.name,
          })
          if (String(repository.data.id) !== source.id) throw invalid('Repository identity changed')
        }
        const binding = { subscriptionId: source.subscriptionId, generation: source.generation }
        // This checkpoint was read from durable Executor storage. Acknowledging
        // here never advances cloud state before local persistence succeeds.
        if (checkpoint.sequence > 0)
          await ctx.git.inbox({ ...binding, operation: 'ack', sequence: checkpoint.sequence })
        const response = await ctx.git.inbox({
          ...binding,
          operation: 'events',
          after: checkpoint.sequence ?? 0,
        })
        if (response.gapBefore > (checkpoint.sequence ?? 0))
          throw Object.assign(new Error('Webhook retention expired; delivery history has a gap'), {
            code: 'git_inbox_gap',
          })
        return {
          events: response.items.map(row => ({
            ...normalizeWebhook(platform, source, row),
            position: { partition: source.subscriptionId, sequence: row.sequence },
          })),
          nextCheckpoint: {
            ...checkpoint,
            sequence: response.items.at(-1)?.sequence ?? checkpoint.sequence,
            identityCheckedAt: identityDue ? Date.now() : checkpoint.identityCheckedAt,
            nextCheckAt: response.hasMore ? 0 : Date.now() + 15000,
          },
          hasMore: response.hasMore,
        }
      }
      return collectPersonal(ctx, platform, source, checkpoint)
    },
  }
}

async function collectActivity(ctx, platform, source, checkpoint) {
  const next = structuredClone(checkpoint)
  next.until ??= new Date().toISOString()
  const profile = parseProfile(source.profile)
  const feeds =
    source.kind === 'repository'
      ? ['repository_events']
      : platform === 'github'
        ? ['activity', 'received_activity']
        : ['activity']
  const page = next.activityPage ?? 1
  if (source.kind === 'repository' && page === 1 && !next.activityFeed) {
    const repository = await ctx.git.read({
      ...profile,
      profile: source.profile,
      operation: 'repository',
      repository: source.name,
    })
    if (String(repository.data.id) !== source.id) throw invalid('Repository identity changed')
  }
  const response = await ctx.git.read({
    ...profile,
    profile: source.profile,
    operation: feeds[next.activityFeed ?? 0],
    repository: source.name,
    page,
  })
  const rows = response.data
  if (!Array.isArray(rows)) throw invalid('Invalid activity event page')
  next.pollIntervalSeconds = Math.max(
    next.pollIntervalSeconds ?? 60,
    response.pollIntervalSeconds ?? 60
  )
  next.seen ??= {}
  next.tracked ??= {}
  const events = []
  for (const row of rows) {
    const at = row.created_at
    if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(source.enabledAfter))
      continue
    const id = String(row.id ?? '')
    if (!id) throw invalid('Activity event ID missing')
    const key = `activity:${id}`
    if (next.seen[key]) continue
    const repository = await activityRepository(ctx, platform, source, row, next)
    const event = normalizeActivity(platform, source, row, repository)
    next.seen[key] = { digest: fingerprint(row), at }
    events.push(event)
    if (['issue', 'change_request'].includes(event.external.entityKind) && event.external.url) {
      if (
        source.kind === 'repository' &&
        source.transport === 'cli' &&
        !next.tracked[event.external.url] &&
        Object.keys(next.tracked).length >= 100
      ) {
        next.openChanges ??= { page: 1 }
        Object.assign(next.openChanges, { complete: false, backlog: true, phase: 'compare' })
        events.push(...coverageEvents(platform, source, next.openChanges, fingerprint))
      } else {
        next.tracked[event.external.url] ??= {
          repository: event.external.repositoryPath,
          number: event.external.entityId,
          entityKind: event.external.entityKind,
          url: event.external.url,
        }
        delete next.tracked[event.external.url].finished
      }
    }
  }
  if (
    Object.keys(next.seen).length > 20000 ||
    Object.keys(next.tracked).length > 100 ||
    (platform === 'github' &&
      page >= 3 &&
      rows.length === 100 &&
      events.length === rows.length &&
      rows.every(row => Date.parse(row.created_at) >= Date.parse(source.enabledAfter)))
  )
    throw Object.assign(new Error('Activity feed exceeds the platform collection budget'), {
      code: 'git_backlog_limit',
    })
  if (rows.length === 100 && (platform !== 'github' || page < 3)) next.activityPage = page + 1
  else {
    next.activityPage = 1
    next.activityFeed = (next.activityFeed ?? 0) + 1
    if (next.activityFeed >= feeds.length) {
      next.activityFeed = 0
      next.activityComplete = true
    }
  }
  return { events, nextCheckpoint: next, hasMore: true }
}

async function activityRepository(ctx, platform, source, row, next) {
  if (source.kind === 'repository') return source.name
  if (platform === 'github') return row.repo?.name ?? ''
  if (row.project?.path_with_namespace) return row.project.path_with_namespace
  const id = String(row.project_id ?? '')
  if (!/^\d+$/.test(id)) return ''
  next.activityProjects ??= {}
  const cached = next.activityProjects[id]
  if (cached && Date.now() - cached.checkedAt < 3600000) return cached.path
  try {
    const result = await ctx.git.read({
      ...parseProfile(source.profile),
      profile: source.profile,
      operation: 'repository',
      repository: id,
    })
    if (String(result.data.id) !== id || typeof result.data.path_with_namespace !== 'string')
      throw invalid('Activity project identity changed')
    next.activityProjects[id] = { path: result.data.path_with_namespace, checkedAt: Date.now() }
    if (Object.keys(next.activityProjects).length > 1000)
      throw Object.assign(new Error('Too many activity projects'), { code: 'git_backlog_limit' })
    return result.data.path_with_namespace
  } catch (error) {
    if (['git_not_found', 'git_permission_denied'].includes(error?.code)) return ''
    throw error
  }
}

function normalizeActivity(platform, source, row, repository) {
  const type =
    row.target_type === 'MergeRequest' || row.note?.noteable_type === 'MergeRequest'
      ? 'merge_request'
      : row.target_type === 'Issue' || row.note?.noteable_type === 'Issue'
        ? 'issue'
        : row.note
          ? 'note'
          : row.target_type
  const number = row.target_iid ?? row.note?.noteable_iid
  const object = {
    id: row.note?.noteable_id ?? row.target_id,
    iid: number,
    title: row.target_title,
    web_url: canonicalTopic(
      platform,
      parseProfile(source.profile).instance,
      repository,
      type === 'merge_request' ? 'change_request' : type,
      number
    ),
  }
  const payload =
    platform === 'github'
      ? { ...row.payload, sender: row.actor }
      : {
          ...row,
          user: row.author,
          object_kind: row.note ? 'note' : type,
          object_attributes: row.note ?? object,
          ...(type === 'issue'
            ? { issue: object }
            : type === 'merge_request'
              ? { merge_request: object }
              : {}),
        }
  const event = normalizeWebhook(
    platform,
    { ...source, id: String(row.repo?.id ?? row.project_id ?? source.id), name: repository },
    {
      id: `activity:${row.id}`,
      eventType: row.type ?? row.action_name ?? type ?? 'activity',
      receivedAt: row.created_at,
      payload,
    }
  )
  event.external.payload = row
  return event
}

async function collectPersonal(ctx, platform, source, checkpoint) {
  const profile = parseProfile(source.profile)
  const next = structuredClone(checkpoint)
  delete next.nextCheckAt
  next.until ??= new Date().toISOString()
  next.seen ??= {}
  next.tracked ??= {}
  if ((next.stream ?? 0) >= STREAMS.length) return collectTracked(ctx, platform, source, next)
  const stream = STREAMS[next.stream ?? 0]
  const response = await ctx.git.read({
    operation: stream,
    ...profile,
    profile: source.profile,
    after: next.after,
    page: next.page ?? 1,
  })
  next.pollIntervalSeconds = Math.max(
    next.pollIntervalSeconds ?? 60,
    response.pollIntervalSeconds ?? 60
  )
  const rows =
    platform === 'github' && stream !== 'notifications' ? response.data.items : response.data
  if (!Array.isArray(rows)) throw invalid('Invalid personal event page')
  if (
    response.data?.incomplete_results ||
    (platform === 'github' && response.data?.total_count > 1000)
  )
    throw Object.assign(
      new Error('Platform search cannot enumerate the complete result; narrow this connection'),
      { code: 'git_backlog_limit' }
    )
  const events = []
  for (const row of rows) {
    const at = row.updated_at ?? row.created_at
    if (
      !Number.isFinite(Date.parse(at)) ||
      Date.parse(at) < Date.parse(source.enabledAfter) ||
      Date.parse(at) < Date.parse(next.after) ||
      Date.parse(at) > Date.parse(next.until)
    )
      continue
    const key = `${stream}:${row.id}`
    const digest = fingerprint(row)
    if (next.seen[key]?.digest === digest) continue
    next.seen[key] = { digest, at }
    const target = personalTarget(platform, profile.instance, row)
    if (target) next.tracked[target.url] = { ...next.tracked[target.url], ...target }
    events.push(normalizePersonal(platform, source, stream, row, at, digest))
  }
  if (Object.keys(next.seen).length > 20000)
    throw Object.assign(new Error('Personal event backlog exceeds the collection budget'), {
      code: 'git_backlog_limit',
    })
  if (rows.length === 100) next.page = (next.page ?? 1) + 1
  else if ((next.stream ?? 0) < STREAMS.length - 1) {
    next.stream = (next.stream ?? 0) + 1
    next.page = 1
  } else {
    next.stream = STREAMS.length
    next.trackIndex = 0
    next.trackStep = 0
    next.page = 1
  }
  if (Object.keys(next.tracked).length > 100)
    throw Object.assign(new Error('More than 100 active tracked objects; narrow the source'), {
      code: 'git_backlog_limit',
    })
  return { events, nextCheckpoint: next, hasMore: !next.nextCheckAt }
}

export function normalizeWebhook(platform, source, delivery) {
  const payload = delivery.payload
  const check = payload.check_run ?? payload.check_suite ?? payload.workflow_run
  const pipeline = payload.object_kind === 'pipeline' ? payload.object_attributes : undefined
  const linkedPull =
    platform === 'github' && check?.pull_requests?.length === 1 ? check.pull_requests[0] : undefined
  const object =
    payload.issue ??
    payload.pull_request ??
    payload.merge_request ??
    linkedPull ??
    payload.object_attributes
  const kind =
    payload.pull_request ||
    payload.issue?.pull_request ||
    payload.merge_request ||
    linkedPull ||
    payload.object_kind === 'merge_request'
      ? 'change_request'
      : payload.issue || payload.object_kind === 'issue'
        ? 'issue'
        : (payload.object_kind ?? delivery.eventType)
  const number = object?.number ?? object?.iid ?? object?.id
  const comment =
    payload.comment ?? (payload.object_kind === 'note' ? payload.object_attributes : undefined)
  const url = object?.html_url ?? object?.web_url ?? object?.url
  const topic =
    number === undefined
      ? `event:${delivery.eventType}:${payload.ref ?? delivery.id}`
      : `${kind}:${number}`
  return {
    id: comment
      ? (canonicalCommentId(
          platform,
          source,
          source.name,
          comment,
          payload.action ?? comment.action
        ) ?? `${platform}:delivery:${delivery.id}`)
      : `${platform}:delivery:${delivery.id}`,
    ...objectVersion(
      platform,
      source,
      source.name,
      comment
        ? 'comment'
        : check
          ? checkKind(payload)
          : pipeline
            ? 'pipeline'
            : payload.review
              ? 'review'
              : kind,
      comment ?? check ?? pipeline ?? payload.review ?? object ?? payload,
      comment
        ? comment.id
        : (check?.id ?? pipeline?.id ?? payload.review?.id ?? number ?? payload.ref ?? delivery.id),
      payload.action ?? comment?.action
    ),
    eventType: 'git.event',
    at: delivery.receivedAt,
    senderId: String(payload.sender?.id ?? payload.user?.id ?? payload.user_id ?? ''),
    senderName: payload.sender?.login ?? payload.user?.username ?? payload.user_username,
    topicId:
      canonicalTopic(
        platform,
        parseProfile(source.profile).instance,
        source.name,
        kind,
        number,
        url
      ) ?? `${source.id}:${topic}`,
    text: renderEvent(platform, source.name, delivery.eventType, payload),
    external: {
      platform,
      ...parseProfile(source.profile),
      repositoryId: source.id,
      repositoryPath: source.name,
      eventType: delivery.eventType,
      action: payload.action ?? object?.action,
      deliveryId: delivery.id,
      sequence: delivery.sequence,
      entityKind: kind,
      entityId: number,
      url: object?.html_url ?? object?.web_url ?? object?.url,
      objectKind: comment ? 'comment' : kind,
      objectUrl: comment?.html_url ?? comment?.url ?? comment?.web_url,
      objectVersion: comment?.updated_at ?? comment?.created_at,
      headSha: payload.pull_request?.head?.sha ?? check?.head_sha ?? object?.last_commit?.id,
      payload,
    },
  }
}

function normalizePersonal(platform, source, stream, row, at, digest) {
  const target = row.target ?? row.subject ?? row
  const repository =
    row.repository?.full_name ?? row.project?.path_with_namespace ?? row.repository_url ?? ''
  const tracked = personalTarget(platform, parseProfile(source.profile).instance, row)
  return {
    id: `${platform}:${stream}:${row.id}:${digest}`,
    objectId: objectIdentity(platform, source, repository, `personal.${stream}`, row.id),
    version: fingerprint(stableValue(row)),
    eventType: 'git.event',
    at,
    topicId: tracked?.url ?? target.url ?? target.web_url ?? row.html_url ?? `${stream}:${row.id}`,
    senderId: String(row.author?.id ?? row.user?.id ?? ''),
    text: renderEvent(platform, repository, `personal.${stream}`, row),
    external: {
      platform,
      ...parseProfile(source.profile),
      eventType: `personal.${stream}`,
      originalId: String(row.id),
      version: digest,
      reason: row.reason ?? row.action_name,
      repositoryPath: repository,
      url: target.web_url ?? row.html_url ?? row.target_url,
      payload: row,
    },
  }
}

function canonicalTopic(platform, instance, repository, kind, number, url) {
  if (['issue', 'change_request'].includes(kind) && number && repository)
    return `${instance}/${repository}/${platform === 'github' ? (kind === 'issue' ? 'issues' : 'pull') : kind === 'issue' ? '-/issues' : '-/merge_requests'}/${number}`
  if (typeof url === 'string') {
    try {
      const value = new URL(url)
      value.hash = ''
      return value.href
    } catch {
      return undefined
    }
  }
}

function personalTarget(platform, instance, row) {
  const target = row.target ?? row.subject ?? row
  const address = target.html_url ?? target.web_url ?? row.html_url ?? row.target_url ?? target.url
  if (typeof address !== 'string') return undefined
  let url
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  const pattern =
    platform === 'github'
      ? /^\/(?:repos\/)?([^/]+\/[^/]+)\/(issues|pulls|pull)\/(\d+)$/
      : /^\/(.+)\/-\/(issues|merge_requests)\/(\d+)$/
  const parts = url.pathname.match(pattern)
  if (!parts || (platform === 'gitlab' && url.origin !== instance)) return undefined
  const kind = parts[2] === 'issues' ? 'issue' : 'change_request'
  return {
    repository: parts[1],
    number: Number(parts[3]),
    entityKind: kind,
    url: canonicalTopic(platform, instance, parts[1], kind, parts[3]),
  }
}

async function collectTracked(ctx, platform, source, next) {
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
  const step = next.trackStep ?? 0
  const steps = target.entityKind === 'change_request' ? 4 : 2
  const operation = step === 0 ? 'object' : step === 1 ? 'comments' : step === 2 ? 'checks' : 'api'
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
      next.tracked[target.url].finished = true
      next.trackIndex = (next.trackIndex ?? 0) + 1
      next.trackStep = 0
      next.page = 1
    } else advanceTracked(next, steps)
    return { events: [], nextCheckpoint: next, hasMore: true }
  }
  if (step === 0) {
    next.tracked[target.url].sha =
      response.data.head?.sha ?? response.data.sha ?? response.data.diff_refs?.head_sha
    if (response.data.state === 'closed' || response.data.state === 'merged')
      next.tracked[target.url].finished = true
    else delete next.tracked[target.url].finished
  }
  const rows = Array.isArray(response.data)
    ? response.data
    : (response.data.check_runs ?? [response.data])
  const events = []
  for (const row of rows) {
    const sourceAt = row.updated_at ?? row.completed_at ?? row.submitted_at ?? row.created_at
    const credibleTime = Number.isFinite(Date.parse(sourceAt))
    const at = credibleTime ? sourceAt : new Date().toISOString()
    if (step === 2 && row.sha && target.sha && row.sha !== target.sha) continue
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
  return { events, nextCheckpoint: next, hasMore: true }
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

function renderEvent(platform, repository, type, payload) {
  const object =
    payload.issue ??
    payload.pull_request ??
    payload.merge_request ??
    payload.object_attributes ??
    payload.target ??
    payload.subject ??
    payload
  const title = object.title ?? payload.name ?? payload.ref ?? ''
  const text =
    payload.comment?.body ??
    payload.object_attributes?.note ??
    object.body ??
    object.description ??
    ''
  return `${platform} · ${repository} · ${type}${title ? ` · ${String(title).slice(0, 300)}` : ''}\n${String(text).slice(0, 4000)}\nPayload fields: ${Object.keys(payload).slice(0, 30).join(', ')}`
}

function canonicalCommentId(platform, source, repository, comment, action) {
  if (comment.id !== undefined && action === 'deleted')
    return `git-canonical:${fingerprint([platform, parseProfile(source.profile).instance, repository, 'comment', String(comment.id), 'deleted'])}`
  const raw = comment.updated_at ?? comment.created_at
  const timestamp =
    typeof raw === 'string' ? Date.parse(raw.replace(/ UTC$/, 'Z').replace(' ', 'T')) : NaN
  const version = Number.isFinite(timestamp) ? String(timestamp) : undefined
  const body = comment.body ?? comment.note
  if (comment.id === undefined || typeof version !== 'string' || typeof body !== 'string')
    return undefined
  return `git-canonical:${fingerprint([platform, parseProfile(source.profile).instance, repository, 'comment', String(comment.id), version, body, action === 'deleted' ? 'deleted' : 'upsert'])}`
}

function objectIdentity(platform, source, repository, kind, id) {
  return JSON.stringify([
    platform,
    parseProfile(source.profile).instance,
    repository,
    kind,
    String(id),
  ])
}

function checkKind(payload) {
  return payload.check_run ? 'check_run' : payload.check_suite ? 'check_suite' : 'workflow_run'
}

function objectVersion(platform, source, repository, kind, object, id, action) {
  const objectId = objectIdentity(platform, source, repository, kind, id)
  if (platform === 'gitlab' && kind === 'pipeline') {
    // Both Pipeline Hook attributes and the MR pipelines API expose these fields.
    // Webhook-only stages/durations and API-only links are not source revisions.
    return {
      objectId,
      version: fingerprint([object.sha ?? null, object.ref ?? null, object.status ?? null]),
    }
  }
  if (kind === 'comment') {
    const canonical = canonicalCommentId(platform, source, repository, object, action)
    if (canonical) return { objectId, version: canonical }
  }
  // Delivery IDs and collection times are transport state, never object versions.
  return {
    objectId,
    version: fingerprint(stableValue([action === 'deleted' ? 'deleted' : 'upsert', object])),
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])])
    )
  return value
}
