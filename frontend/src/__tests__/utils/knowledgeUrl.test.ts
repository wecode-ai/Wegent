import { buildKbUrl, parseKbUrl, resolveKbByVirtualPath } from '@/utils/knowledgeUrl'

const company = { id: 202, name: '工程与算法', namespace: 'acme-org' }
const team = { id: 101, name: '工程与算法', namespace: 'team' }
const personal = { id: 303, name: '工程与算法', namespace: 'default' }
const all = [team, personal, company]
const resolve = (namespace: string | null, name = '工程与算法') =>
  resolveKbByVirtualPath({
    allKnowledgeBases: all,
    organizationKnowledgeBases: [company],
    namespace,
    name,
    isLoading: false,
  })

describe('knowledge URL scope resolution', () => {
  it('round trips a company URL and resolves only inside the company collection', () => {
    const parsed = parseKbUrl(buildKbUrl(company.namespace, company.name, true))!
    expect(parsed).toMatchObject({ type: 'organization', namespace: null })
    expect(resolve(parsed.namespace, parsed.kbName)).toEqual({
      status: 'resolved',
      knowledgeBase: company,
    })
  })

  it.each([
    ['default', personal],
    ['TEAM', team],
  ])('matches namespace %s case insensitively', (namespace, expected) => {
    expect(resolve(namespace)).toEqual({ status: 'resolved', knowledgeBase: expected })
  })

  it('does not cross scopes on missing names or namespaces', () => {
    expect(resolve('absent')).toEqual({ status: 'not-found' })
    expect(resolve(null, 'absent')).toEqual({ status: 'not-found' })
  })

  it.each([null, 'team'])('rejects ambiguous different IDs within scope %s', namespace => {
    const kb = namespace ? team : company
    expect(
      resolveKbByVirtualPath({
        allKnowledgeBases: [kb, { ...kb, id: 404 }],
        organizationKnowledgeBases: [kb, { ...kb, id: 404 }],
        namespace,
        name: kb.name,
        isLoading: false,
      })
    ).toEqual({ status: 'ambiguous' })
  })

  it('deduplicates shared occurrences by ID', () => {
    expect(
      resolveKbByVirtualPath({
        allKnowledgeBases: all,
        organizationKnowledgeBases: [company, { ...company }],
        namespace: null,
        name: company.name,
        isLoading: false,
      })
    ).toEqual({ status: 'resolved', knowledgeBase: company })
  })

  it('keeps document paths attached to the scoped route', () => {
    const url = buildKbUrl('team', 'My KB', false, 'folder/doc.md')
    expect(parseKbUrl(url)).toEqual({
      type: 'team',
      namespace: 'team',
      kbName: 'My KB',
      docPath: 'folder/doc.md',
    })
  })
})

it('resolves the selected ID despite a stale name and same-scope duplicates', () => {
  const selected = { ...company, id: 404, name: '改名后的库' }
  expect(
    resolveKbByVirtualPath({
      allKnowledgeBases: [company, selected],
      organizationKnowledgeBases: [company, selected],
      namespace: null,
      name: '工程与算法',
      knowledgeBaseId: '404',
      isLoading: false,
    })
  ).toEqual({ status: 'resolved', knowledgeBase: selected })
})

it.each(['', '0', '-1', '202x', '1.5', '1e2', '9007199254740992', '999', '101', '303'])(
  'rejects invalid, unavailable or out-of-scope ID %s without name fallback',
  knowledgeBaseId => {
    expect(
      resolveKbByVirtualPath({
        allKnowledgeBases: all,
        organizationKnowledgeBases: [company],
        namespace: null,
        name: company.name,
        knowledgeBaseId,
        isLoading: false,
      })
    ).toEqual({ status: 'not-found' })
  }
)

it('rejects a valid company ID at a different team namespace', () => {
  expect(
    resolveKbByVirtualPath({
      allKnowledgeBases: all,
      organizationKnowledgeBases: [company],
      namespace: 'team',
      name: team.name,
      knowledgeBaseId: '202',
      isLoading: false,
    })
  ).toEqual({ status: 'not-found' })
})

it('builds a stable document link and preserves query parameters while replacing conflicting IDs', () => {
  const url = new URL(
    buildKbUrl('acme-org', 'Renamed KB', true, 'folder/doc.md', {
      knowledgeBaseId: 202,
      searchParams: 'kb=999&taskId=123&documentId=7&kb=101',
    }),
    'https://example.com'
  )
  expect(url.pathname).toBe('/knowledge/public/Renamed%20KB/folder/doc.md')
  expect(url.searchParams.getAll('kb')).toEqual(['202'])
  expect(url.searchParams.get('taskId')).toBe('123')
  expect(url.searchParams.get('documentId')).toBe('7')
})
