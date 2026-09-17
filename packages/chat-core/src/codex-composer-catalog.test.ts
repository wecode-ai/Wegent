import { describe, expect, it, vi } from 'vitest'
import {
  decodeCodexComposerApps,
  decodeCodexComposerSkills,
  listCodexComposerApps,
} from './codex-composer-catalog'

describe('shared Codex composer catalogs', () => {
  it('preserves inaccessible apps for installed-membership merging when requested', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 'visible', name: 'Visible' }], nextCursor: 'next' })
      .mockResolvedValueOnce({
        data: [
          { id: 'unlinked', name: 'Unlinked', isAccessible: false },
          { id: 'disabled', name: 'Disabled', isEnabled: false },
        ],
        nextCursor: null,
      })
    const apps = await listCodexComposerApps(request, {
      includeInaccessible: true,
      forceRefetch: true,
    })
    expect(apps.map(app => app.id)).toEqual(['visible', 'unlinked'])
    expect(request).toHaveBeenNthCalledWith(2, 'app/list', {
      cursor: 'next',
      limit: 100,
      forceRefetch: true,
    })
    expect(apps[1].isAccessible).toBe(false)
  })
  it('does not expose unlinked apps by default or retry a failed page', async () => {
    expect(
      await listCodexComposerApps(
        vi.fn().mockResolvedValue({
          data: [{ id: 'unlinked', name: 'Unlinked', isAccessible: false }],
          nextCursor: null,
        })
      )
    ).toEqual([])
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 'a', name: 'A' }], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('offline'))
    await expect(listCodexComposerApps(request)).rejects.toThrow('offline')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects repeated cursors instead of looping forever', async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: 'same' })
    await expect(listCodexComposerApps(request)).rejects.toThrow('Repeated app catalog cursor')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('uses PC metadata precedence and excludes disabled skills', () => {
    const skills = decodeCodexComposerSkills([
      {
        skills: [
          {
            name: 'pdf',
            path: '/project/pdf',
            scope: 'repo',
            description: 'Full description',
            shortDescription: 'Short',
            interface: { shortDescription: 'Interface' },
          },
          { name: 'hidden', path: '/hidden', enabled: false },
          { name: 'admin', path: '/admin', scope: 'admin', short_description: 'Admin description' },
        ],
      },
    ])
    expect(skills).toHaveLength(2)
    expect(skills[0]).toMatchObject({
      name: 'pdf',
      path: '/project/pdf',
      description: 'Interface',
      short_description: 'Interface',
      source: 'codex',
      scope: 'repo',
      source_priority: 0,
    })
    expect(skills[1]).toMatchObject({ description: 'Admin description', source_priority: 1 })
  })
  it('surfaces malformed data and per-workspace skill errors', () => {
    expect(() =>
      decodeCodexComposerApps([{ id: 'app', name: 'App', isAccessible: 'false' }])
    ).toThrow('flag')
    expect(() => decodeCodexComposerApps({})).toThrow('list')
    expect(() =>
      decodeCodexComposerSkills([{ skills: [], errors: [{ path: '/bad', message: 'unreadable' }] }])
    ).toThrow('read errors')
    expect(() => decodeCodexComposerSkills([{ skills: [{ name: 'broken' }] }])).toThrow(
      'identifier'
    )
  })
})
