import { describe, expect, test } from 'vitest'
import {
  canRecoverShareAfterVersionConflict,
  resolvePluginOwnerActions,
} from './pluginOwnerActions'

describe('resolvePluginOwnerActions', () => {
  test('gives an unpublished local plugin one Share action without a publish whitelist', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: null,
      })
    ).toEqual({
      showShareAction: true,
      canManageAccess: false,
    })
  })

  test('personal owner keeps access management and uses the unified Share action', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: { accessRole: 'owner', visibility: 'personal' },
      })
    ).toEqual({
      showShareAction: true,
      canManageAccess: true,
    })
  })

  test('personal owner can still manage sharing while the local package hydrates', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'owner', visibility: 'personal' },
      })
    ).toEqual({
      showShareAction: true,
      canManageAccess: true,
    })
  })

  test('enterprise and public catalog identities do not expose owner distribution actions', () => {
    for (const visibility of ['workspace', 'public'] as const) {
      expect(
        resolvePluginOwnerActions({
          isLocalCreated: true,
          ownedListing: { accessRole: 'owner', visibility },
        })
      ).toEqual({
        showShareAction: false,
        canManageAccess: false,
      })
    }
  })

  test('a received or catalog plugin never receives owner actions', () => {
    for (const accessRole of ['recipient', 'catalog'] as const) {
      expect(
        resolvePluginOwnerActions({
          isLocalCreated: true,
          ownedListing: { accessRole, visibility: 'personal' },
        })
      ).toEqual({
        showShareAction: false,
        canManageAccess: false,
      })
    }
  })
})

describe('canRecoverShareAfterVersionConflict', () => {
  test('only personal owners can recover into the share dialog', () => {
    expect(
      canRecoverShareAfterVersionConflict({ accessRole: 'owner', visibility: 'personal' })
    ).toBe(true)
    expect(
      canRecoverShareAfterVersionConflict({ accessRole: 'owner', visibility: 'workspace' })
    ).toBe(false)
    expect(canRecoverShareAfterVersionConflict(null)).toBe(false)
  })
})
