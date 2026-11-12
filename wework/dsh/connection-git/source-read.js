import { randomUUID } from 'node:crypto'

const PAGE_SIZE = 100
const TTL_MS = 30 * 60 * 1000
const SHA = /^[a-fA-F0-9]{40}$/
const VIEWS = ['details', 'comments', 'checks', 'statuses', 'reviews', 'logs']
const invalid = message => Object.assign(new Error(message), { code: 'git_connection_invalid' })
const cursorInvalid = () =>
  Object.assign(
    new Error('Read cursor expired, changed or belongs to another source; restart the read'),
    { code: 'source_read_cursor_invalid' }
  )
const binding = source =>
  JSON.stringify(
    [
      'providerId',
      'profile',
      'kind',
      'id',
      'name',
      'transport',
      'subscriptionId',
      'generation',
      'enabledAfter',
    ].map(key => source[key] ?? null)
  )
const normalizedQuery = query => ({
  entityKind: query.entityKind,
  number: query.number,
  view: query.view,
  ...(query.sha === undefined ? {} : { sha: query.sha }),
})

export function createGitSourceReader(platform, parseProfile) {
  const cursors = new Map()
  return async (ctx, input) => {
    const source = input.source
    validateSource(platform, source)
    const identity = parseProfile(source.profile)
    let state = input.cursor === undefined ? null : cursors.get(input.cursor)
    if (
      input.cursor !== undefined &&
      (!state || state.binding !== binding(source) || state.expiresAt < Date.now())
    )
      throw cursorInvalid()
    if (input.query !== undefined) {
      validateQuery(input.query)
      if (state && JSON.stringify(normalizedQuery(input.query)) !== JSON.stringify(state.query))
        throw cursorInvalid()
    }
    const query = state?.query ?? normalizedQuery(validateQuery(input.query))
    const read = async args => {
      const result = await ctx.git.read({
        ...args,
        ...identity,
        profile: source.profile,
        repository: source.name,
      })
      if (result.profile !== source.profile) throw invalid('The selected Git account changed')
      return result.data
    }
    const repository = await read({ operation: 'repository' })
    if (
      !repository ||
      String(repository.id) !== source.id ||
      repository[platform === 'github' ? 'full_name' : 'path_with_namespace'] !== source.name
    )
      throw invalid('The connected repository identity changed')
    state ??= { binding: binding(source), query, page: 1, expiresAt: Date.now() + TTL_MS }
    if (['checks', 'statuses'].includes(query.view) && !state.sha)
      state.sha =
        query.sha ??
        headSha(
          platform,
          await read({ operation: 'object', entityKind: query.entityKind, number: query.number })
        )
    if (state.sha) state.sha = state.sha.toLowerCase()
    const data = await read(readArguments(platform, query, state))
    if (
      query.view === 'details' &&
      data?.[platform === 'github' ? 'number' : 'iid'] !== query.number
    )
      throw invalid('Native Git details do not match the requested object')
    const rows = readRows(platform, query, data)
    if (rows.length > PAGE_SIZE) throw invalid('Native Git page exceeds its declared page size')
    const hasMore = isList(platform, query.view) && rows.length === PAGE_SIZE
    if (hasMore && state.page >= 10000) throw invalid('Native Git page limit reached')
    if (
      query.view === 'checks' &&
      rows.some(row => typeof row[platform === 'github' ? 'head_sha' : 'sha'] !== 'string')
    )
      throw invalid('Native Git checks did not identify their commit')
    if (
      platform === 'github' &&
      query.view === 'checks' &&
      rows.some(row => row.head_sha.toLowerCase() !== state.sha)
    )
      throw invalid('Native Git checks belong to another commit')
    const selected =
      platform === 'gitlab' && query.view === 'checks'
        ? rows.filter(row => row.sha.toLowerCase() === state.sha)
        : rows
    const items = selected.map(row => ({
      id: JSON.stringify([
        platform,
        source.profile,
        source.id,
        query.entityKind,
        query.number,
        query.view,
        query.view === 'logs' ? row.jobId : rowId(row),
      ]),
      data: row,
    }))
    let nextCursor
    if (hasMore) {
      for (const [key, value] of cursors) if (value.expiresAt < Date.now()) cursors.delete(key)
      if (cursors.size >= 1000) cursors.delete(cursors.keys().next().value)
      nextCursor = randomUUID()
      cursors.set(nextCursor, { ...state, page: state.page + 1 })
    }
    return {
      items,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      query: structuredClone(state.query),
      ...(state.sha ? { commitSha: state.sha } : {}),
      page: state.page,
      readOnly: true,
    }
  }
}

function validateSource(platform, source) {
  if (
    source?.providerId !== '@wegent/dsh-connection-git/' + platform ||
    source.kind !== 'repository' ||
    source.scope !== undefined ||
    typeof source.id !== 'string' ||
    !source.id ||
    source.id === '*' ||
    typeof source.name !== 'string' ||
    !source.name ||
    typeof source.profile !== 'string' ||
    (source.transport !== undefined && !['cli', 'webhook'].includes(source.transport))
  )
    throw invalid('Read one exact connected Git repository')
}

function validateQuery(query) {
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).some(key => !['entityKind', 'number', 'view', 'sha'].includes(key)) ||
    !['issue', 'change_request', 'job'].includes(query.entityKind) ||
    !Number.isSafeInteger(query.number) ||
    query.number < 1 ||
    !VIEWS.includes(query.view) ||
    (query.entityKind === 'job'
      ? query.view !== 'logs'
      : query.view === 'logs' ||
        (query.view !== 'details' &&
          query.view !== 'comments' &&
          query.entityKind !== 'change_request')) ||
    (query.sha !== undefined &&
      (typeof query.sha !== 'string' ||
        !SHA.test(query.sha) ||
        !['checks', 'statuses'].includes(query.view)))
  )
    throw invalid('Select a declared Git object and read view')
  return query
}

function headSha(platform, data) {
  const sha = platform === 'github' ? data?.head?.sha : (data?.diff_refs?.head_sha ?? data?.sha)
  if (typeof sha !== 'string' || !SHA.test(sha))
    throw invalid('Native Git details did not provide a valid head SHA')
  return sha
}

function readArguments(platform, query, state) {
  if (query.view === 'logs') return { operation: 'job_log', jobId: query.number }
  const common = { entityKind: query.entityKind, number: query.number, page: state.page }
  if (query.view === 'statuses')
    return {
      ...common,
      operation: 'api',
      path:
        (platform === 'github' ? 'commits/' : 'repository/commits/') +
        state.sha +
        '/statuses?per_page=100&page=' +
        state.page,
    }
  if (query.view === 'reviews')
    return {
      ...common,
      operation: 'api',
      path:
        platform === 'github'
          ? 'pulls/' + query.number + '/reviews?per_page=100&page=' + state.page
          : 'merge_requests/' + query.number + '/approvals',
    }
  return {
    ...common,
    operation: query.view === 'details' ? 'object' : query.view,
    ...(query.view === 'checks' ? { sha: state.sha } : {}),
  }
}

function isList(platform, view) {
  return !['details', 'logs'].includes(view) && !(platform === 'gitlab' && view === 'reviews')
}

function readRows(platform, query, data) {
  if (!isList(platform, query.view)) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw invalid('Invalid native Git object response')
    if (
      query.view === 'logs' &&
      (typeof data.text !== 'string' || data.jobId !== String(query.number))
    )
      throw invalid('Native Git log does not match the requested job')
    return [data]
  }
  const rows = platform === 'github' && query.view === 'checks' ? data?.check_runs : data
  if (!Array.isArray(rows)) throw invalid('Invalid native Git list response')
  for (const row of rows) rowId(row)
  return rows
}

function rowId(row) {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    !['string', 'number'].includes(typeof row.id) ||
    String(row.id).length === 0
  )
    throw invalid('Native Git object has no stable ID')
  return String(row.id)
}
