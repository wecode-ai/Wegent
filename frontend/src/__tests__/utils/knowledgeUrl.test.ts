import { findKbByVirtualPath } from '@/utils/knowledgeUrl'

interface TestKb {
  name: string
  namespace: string
}

describe('findKbByVirtualPath', () => {
  const personalKbs: TestKb[] = [
    { name: 'mykb', namespace: 'default' },
    { name: 'otherkb', namespace: 'default' },
  ]

  const teamKbs: TestKb[] = [
    { name: 'ourdocs', namespace: 'team42' },
    { name: 'projectdocs', namespace: 'team42' },
  ]

  const mixedKbs: TestKb[] = [
    { name: 'mykb', namespace: 'default' },
    { name: 'publickb', namespace: 'organization' },
    { name: 'ourteamkb', namespace: 'team-alpha' },
  ]

  it('matches personal KB by namespace and name', () => {
    const result = findKbByVirtualPath(personalKbs, 'default', 'MyKb')
    expect(result).toEqual({ name: 'mykb', namespace: 'default' })
  })

  it('matches team KB by namespace and name', () => {
    const result = findKbByVirtualPath(teamKbs, 'team42', 'OurDocs')
    expect(result).toEqual({ name: 'ourdocs', namespace: 'team42' })
  })

  it('matches organization KB with undefined namespace (ignores namespace)', () => {
    const result = findKbByVirtualPath(mixedKbs, undefined, 'PublicKb')
    expect(result).toEqual({ name: 'publickb', namespace: 'organization' })
  })

  it('matches organization KB with null namespace (ignores namespace)', () => {
    const result = findKbByVirtualPath(mixedKbs, null, 'PublicKb')
    expect(result).toEqual({ name: 'publickb', namespace: 'organization' })
  })

  it('matches organization KB with empty string namespace (ignores namespace)', () => {
    const result = findKbByVirtualPath(mixedKbs, '', 'PublicKb')
    expect(result).toEqual({ name: 'publickb', namespace: 'organization' })
  })

  it('is case-insensitive when matching name and namespace', () => {
    const result = findKbByVirtualPath(personalKbs, 'Default', 'MyKB')
    expect(result).toEqual({ name: 'mykb', namespace: 'default' })
  })

  it('returns undefined when no match exists', () => {
    const result = findKbByVirtualPath(personalKbs, 'default', 'nonexistent')
    expect(result).toBeUndefined()
  })

  it('returns undefined when namespace is provided but does not match', () => {
    const result = findKbByVirtualPath(mixedKbs, 'wrong', 'mykb')
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty array', () => {
    const result = findKbByVirtualPath([], 'default', 'anything')
    expect(result).toBeUndefined()
  })

  it('matches first occurrence when multiple KBs have the same name in the same namespace', () => {
    const kbs: TestKb[] = [
      { name: 'dupname', namespace: 'default' },
      { name: 'dupname', namespace: 'default' },
    ]
    const result = findKbByVirtualPath(kbs, 'default', 'dupname')
    expect(result).toEqual({ name: 'dupname', namespace: 'default' })
  })
})
