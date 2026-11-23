import { createHash } from 'node:crypto'

// Review only public issue/change-request discussions in this authorized repository.
// Other feedback channels, including inline reviews and private discussions, are not covered.
const invalid = message => Object.assign(new Error(message), { code: 'git_connection_invalid' })

export function reviewQuery(query) {
  const start = Date.parse(query.since)
  const end = Date.parse(query.trainingUntil)
  const limit = query.limit ?? 20
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end > Date.now() ||
    start > end ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw invalid('Invalid discussion review window')
  return { since: new Date(start).toISOString(), trainingUntil: new Date(end).toISOString(), limit }
}

export function initialReview(platform, source) {
  if (source.kind === 'personal')
    return {
      lists:
        source.transport !== 'cli'
          ? ['assigned', 'reviews']
          : platform === 'github'
            ? ['activity', 'received_activity']
            : ['activity'],
      page: 1,
      offset: 0,
    }
  const selected = source.monitoredObjects
  const runKind = platform === 'github' ? 'workflow_run' : 'pipeline'
  if (
    source.branch ||
    source.observeCurrentStatus === true ||
    (selected?.length && selected.every(({ entityKind }) => entityKind === runKind))
  )
    return { useCollectedEvents: true }
  return {
    objects: (selected ?? []).filter(({ entityKind }) =>
      ['issue', 'change_request'].includes(entityKind)
    ),
    lists: selected ? [] : platform === 'github' ? ['issues'] : ['issues', 'merge_requests'],
    page: 1,
    commentPage: 0,
  }
}

function pageRows(data, limit) {
  if (!Array.isArray(data) || data.length > limit)
    throw invalid('Expected a bounded native discussion page')
  return data
}

// Native REST feeds use page numbers. Keep only a digest of visible positions
// and revisions, and verify the boundary again using the current credentials.
async function guardedPage(read, page, previous) {
  const rows = await read(page)
  const fingerprint = rows =>
    createHash('sha256')
      .update(
        JSON.stringify(
          rows.map(row => [
            row.id ?? row.number ?? row.iid ?? row.note?.id ?? row.payload?.comment?.id,
            row.updated_at ?? row.created_at,
            row.note?.updated_at ?? row.payload?.comment?.updated_at,
          ])
        )
      )
      .digest('hex')
  const digest = fingerprint(rows)
  if (
    previous &&
    (previous.page === page ? digest : fingerprint(await read(previous.page))) !== previous.digest
  )
    throw Object.assign(new Error('Native Git history changed; restart the read'), {
      code: 'source_read_cursor_invalid',
    })
  return { rows, boundary: { page, digest } }
}

function privateGitLabPost(row) {
  return row.internal === true || row.confidential === true
}

async function discover(platform, query, state, read) {
  const list = state.lists[0]
  const github = platform === 'github'
  const params = github
    ? 'state=all&sort=updated&direction=desc' + (list === 'issues' ? '&since=' + query.since : '')
    : 'scope=all&order_by=updated_at&sort=desc&updated_after=' + query.since
  const load = async page =>
    pageRows(
      await read({
        operation: 'api',
        path: list + '?' + params + '&per_page=' + query.limit + '&page=' + page,
      }),
      query.limit
    )
  const { rows, boundary } = await guardedPage(load, state.page, state.discoveryBoundary)
  let ended = rows.length < query.limit
  for (const row of rows) {
    const updated = Date.parse(row.updated_at)
    const number = github ? row.number : row.iid
    if (!Number.isFinite(updated) || !Number.isSafeInteger(number) || number <= 0)
      throw invalid('Invalid native discussion identity or timestamp')
    if (updated < Date.parse(query.since)) {
      ended = true
      continue
    }
    const entityKind = list !== 'issues' || row.pull_request ? 'change_request' : 'issue'
    state.objects.push({ entityKind, number })
  }
  if (ended) {
    state.lists.shift()
    state.page = 1
    delete state.discoveryBoundary
  } else {
    state.discoveryBoundary = boundary
    state.page++
  }
}

function reviewItem(platform, identity, source, target, row, query, isRoot, canonicalCommentId) {
  const github = platform === 'github'
  const actor = github ? row.user : row.author
  if (row.system === true || (!github && privateGitLabPost(row))) return null
  const created = Date.parse(row.created_at)
  const timestamp = Math.max(
    created,
    ...[row.updated_at, row.edited_at, row.last_edited_at]
      .filter(value => value != null)
      .map(value => Date.parse(value))
  )
  if (!Number.isFinite(timestamp)) throw invalid('Native post has no creation time')
  if (timestamp < Date.parse(query.since) || timestamp >= Date.parse(query.trainingUntil))
    return null
  const text = isRoot
    ? [row.title, github ? row.body : row.description].filter(Boolean).join('\n\n')
    : row.body
  if (typeof text !== 'string') throw invalid('Native post has no text')
  if (!text.trim()) return null
  const part = target.entityKind === 'issue' ? 'issues' : github ? 'pull' : 'merge_requests'
  const topic =
    target.url ??
    identity.instance + '/' + source.name + (github ? '/' : '/-/') + part + '/' + target.number
  const id = isRoot
    ? topic
    : (target.noteId ?? canonicalCommentId(platform, source, source.name, row, 'upsert'))
  if (!id) throw invalid('Native comment has no verifiable identity')
  const budget = Math.floor(24000 / query.limit)
  const actorId = actor?.id == null ? '' : String(actor.id)
  // An account can use its CLI token in automation too. Only an actual send receipt
  // can attribute such a post to this assistant. Edited content has uncertain authorship.
  let author = 'unknown'
  const edited = row.edited_at || row.last_edited_at || timestamp !== created
  if (
    !edited &&
    actorId &&
    !row.performed_via_github_app &&
    !actor.bot &&
    (github ? actor.type === 'User' : actor.username && actor.state !== 'blocked')
  ) {
    author = actorId === identity.accountId ? 'authenticatedAccount' : 'participant'
  }
  return {
    id,
    at: new Date(timestamp).toISOString(),
    text: text.slice(0, budget),
    truncated: text.length > budget,
    author,
    ...(author === 'participant' ? { participantId: actorId } : {}),
    conversationId: topic,
    topicId: topic,
  }
}

function personalActivity(platform, source, identity, event, query, canonicalCommentId) {
  const github = platform === 'github'
  if (github && event.payload?.action !== 'created') return null
  const row = github ? event.payload?.comment : event.note
  if (!row) return null
  const repo = github ? event.repo?.name : event.project?.path_with_namespace
  const object = github ? (event.payload?.issue ?? event.payload?.pull_request) : row
  if (!object || (!github && !['Issue', 'MergeRequest'].includes(row.noteable_type))) return null
  const number = github ? object.number : (row.noteable_iid ?? event.target_iid)
  const pr = github
    ? object.pull_request || event.payload?.pull_request
    : row.noteable_type === 'MergeRequest'
  const target = { entityKind: pr ? 'change_request' : 'issue', number }
  if (!repo || !Number.isSafeInteger(number) || number <= 0) {
    const project = event.project_id ?? row.project_id
    if (
      github ||
      ![project, row.noteable_id, row.id].every(id => Number.isSafeInteger(id) && id > 0)
    )
      return null
    // Personal GitLab events can identify the project and object only by global ID.
    // Preserve those IDs without opening the project or guessing its path or IID.
    target.url = JSON.stringify([
      identity.instance,
      'project',
      project,
      row.noteable_type,
      row.noteable_id,
    ])
    target.noteId = JSON.stringify([identity.instance, 'project', project, 'note', row.id])
  }
  const author = row.author ?? (row.author_id === event.author?.id ? event.author : undefined)
  return reviewItem(
    platform,
    identity,
    { ...source, name: repo },
    target,
    github ? row : { ...row, author },
    query,
    false,
    canonicalCommentId
  )
}

// Account feeds do not authorize following links into other repositories.
export async function readActivityPage(
  platform,
  source,
  identity,
  query,
  state,
  read,
  canonicalCommentId,
  personalTarget
) {
  const github = platform === 'github'
  const operation = state.lists[0]
  const search = operation === 'assigned' || operation === 'reviews'
  const load = async page => {
    const response = await read({ operation, page, ...(search ? { after: query.since } : {}) })
    return pageRows(search && github ? response?.items : response, 100)
  }
  const { rows, boundary } = await guardedPage(load, state.page, state.activityBoundary)
  state.activityBoundary = boundary
  const items = []
  while (state.offset < rows.length && items.length < query.limit) {
    const event = rows[state.offset++]
    let item
    if (search) {
      const target = personalTarget(platform, identity.instance, event)
      if (target)
        item = reviewItem(
          platform,
          identity,
          source,
          target,
          event,
          query,
          true,
          canonicalCommentId
        )
    } else item = personalActivity(platform, source, identity, event, query, canonicalCommentId)
    if (item) items.push(item)
  }
  if (state.offset >= rows.length) {
    if (
      rows.length < 100 ||
      (github && state.page >= (search ? 10 : 3)) ||
      (!search && rows.some(row => Date.parse(row.created_at) < Date.parse(query.since)))
    ) {
      state.lists.shift()
      state.page = 1
      delete state.activityBoundary
    } else state.page++
    state.offset = 0
  }
  return { items, hasMore: state.lists.length > 0 }
}

export async function readReviewPage(
  platform,
  source,
  identity,
  query,
  state,
  read,
  canonicalCommentId
) {
  if (state.useCollectedEvents) return { items: [], hasMore: false, reviewUseCollectedEvents: true }
  const items = []
  if (!state.objects.length && state.lists.length) await discover(platform, query, state, read)
  const target = state.objects[0]
  if (target) {
    const github = platform === 'github'
    let data
    if (!state.commentPage || !github) {
      data = await read({ operation: 'object', ...target })
      const number = platform === 'github' ? data?.number : data?.iid
      if (
        number !== target.number ||
        (platform === 'github' && target.entityKind === 'issue' && data.pull_request)
      )
        throw invalid('Selected discussion changed')
    }
    if (!github && privateGitLabPost(data)) {
      state.objects.shift()
      state.commentPage = 0
      delete state.commentBoundary
    } else if (!state.commentPage) {
      const item = reviewItem(
        platform,
        identity,
        source,
        target,
        data,
        query,
        true,
        canonicalCommentId
      )
      if (item) items.push(item)
      state.commentPage = 1
    } else {
      const path = github
        ? 'issues/' + target.number + '/comments?since=' + query.since
        : (target.entityKind === 'issue' ? 'issues' : 'merge_requests') +
          '/' +
          target.number +
          '/notes?order_by=updated_at&sort=desc'
      const load = async page =>
        pageRows(
          await read({
            operation: 'api',
            path: path + '&per_page=' + query.limit + '&page=' + page,
          }),
          query.limit
        )
      const { rows, boundary } = await guardedPage(load, state.commentPage, state.commentBoundary)
      for (const row of rows) {
        const item = reviewItem(
          platform,
          identity,
          source,
          target,
          row,
          query,
          false,
          canonicalCommentId
        )
        if (item) items.push(item)
      }
      if (
        rows.length < query.limit ||
        rows.some(row => Date.parse(row.updated_at) < Date.parse(query.since))
      ) {
        state.objects.shift()
        state.commentPage = 0
        delete state.commentBoundary
      } else {
        state.commentBoundary = boundary
        state.commentPage++
      }
    }
  }
  return { items, hasMore: state.objects.length > 0 || state.lists.length > 0 }
}
