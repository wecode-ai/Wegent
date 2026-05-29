import { renderHook } from '@testing-library/react'

import type { BaseRole } from '@/types/base-role'

import { useGroupPermissions } from '@/hooks/useGroupPermissions'

describe('useGroupPermissions', () => {
  it('returns false for all permissions when groupRoleMap is undefined', () => {
    const { result } = renderHook(() => useGroupPermissions({}))

    expect(result.current.canEditGroupResource('ns')).toBe(false)
    expect(result.current.canDeleteGroupResource('ns')).toBe(false)
    expect(result.current.canCreateInCurrentGroup).toBe(false)
    expect(result.current.canCreateInAnyGroup).toBe(false)
  })

  it('returns false when groupRoleMap is an empty Map', () => {
    const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: new Map() }))

    expect(result.current.canEditGroupResource('ns')).toBe(false)
    expect(result.current.canDeleteGroupResource('ns')).toBe(false)
    expect(result.current.canCreateInCurrentGroup).toBe(false)
    expect(result.current.canCreateInAnyGroup).toBe(false)
  })

  describe('canEditGroupResource', () => {
    const roleMap = new Map<string, BaseRole>([
      ['team-a', 'Owner'],
      ['team-b', 'Maintainer'],
      ['team-c', 'Developer'],
      ['team-d', 'Reporter'],
    ])

    it('returns true for Owner', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canEditGroupResource('team-a')).toBe(true)
    })

    it('returns true for Maintainer', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canEditGroupResource('team-b')).toBe(true)
    })

    it('returns true for Developer', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canEditGroupResource('team-c')).toBe(true)
    })

    it('returns false for Reporter', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canEditGroupResource('team-d')).toBe(false)
    })

    it('returns false for unknown namespace', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canEditGroupResource('unknown')).toBe(false)
    })
  })

  describe('canDeleteGroupResource', () => {
    const roleMap = new Map<string, BaseRole>([
      ['team-a', 'Owner'],
      ['team-b', 'Maintainer'],
      ['team-c', 'Developer'],
    ])

    it('returns true for Owner', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canDeleteGroupResource('team-a')).toBe(true)
    })

    it('returns true for Maintainer', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canDeleteGroupResource('team-b')).toBe(true)
    })

    it('returns false for Developer', () => {
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canDeleteGroupResource('team-c')).toBe(false)
    })
  })

  describe('canCreateInCurrentGroup', () => {
    const roleMap = new Map<string, BaseRole>([['my-group', 'Maintainer']])

    it('returns true when scope=group and role is Owner', () => {
      const ownerMap = new Map<string, BaseRole>([['my-group', 'Owner']])
      const { result } = renderHook(() =>
        useGroupPermissions({
          scope: 'group',
          groupName: 'my-group',
          groupRoleMap: ownerMap,
        })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(true)
    })

    it('returns true when scope=group and role is Maintainer', () => {
      const { result } = renderHook(() =>
        useGroupPermissions({
          scope: 'group',
          groupName: 'my-group',
          groupRoleMap: roleMap,
        })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(true)
    })

    it('returns false when scope is personal', () => {
      const { result } = renderHook(() =>
        useGroupPermissions({
          scope: 'personal',
          groupName: 'my-group',
          groupRoleMap: roleMap,
        })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(false)
    })

    it('returns false when scope is all', () => {
      const { result } = renderHook(() =>
        useGroupPermissions({
          scope: 'all',
          groupName: 'my-group',
          groupRoleMap: roleMap,
        })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(false)
    })

    it('returns false when groupName is undefined', () => {
      const { result } = renderHook(() =>
        useGroupPermissions({ scope: 'group', groupRoleMap: roleMap })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(false)
    })

    it('returns false when role is Developer', () => {
      const devMap = new Map<string, BaseRole>([['my-group', 'Developer']])
      const { result } = renderHook(() =>
        useGroupPermissions({
          scope: 'group',
          groupName: 'my-group',
          groupRoleMap: devMap,
        })
      )
      expect(result.current.canCreateInCurrentGroup).toBe(false)
    })
  })

  describe('canCreateInAnyGroup', () => {
    it('returns true when user is Maintainer in at least one group', () => {
      const roleMap = new Map<string, BaseRole>([
        ['team-a', 'Reporter'],
        ['team-b', 'Maintainer'],
      ])
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canCreateInAnyGroup).toBe(true)
    })

    it('returns false when user has no Manager role in any group', () => {
      const roleMap = new Map<string, BaseRole>([
        ['team-a', 'Reporter'],
        ['team-b', 'Developer'],
      ])
      const { result } = renderHook(() => useGroupPermissions({ groupRoleMap: roleMap }))
      expect(result.current.canCreateInAnyGroup).toBe(false)
    })
  })
})
