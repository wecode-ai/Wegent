import { describe, expect, test } from 'vitest'
import {
  canRecoverShareAfterVersionConflict,
  resolvePluginOwnerActions,
} from './pluginOwnerActions'

describe('resolvePluginOwnerActions', () => {
  test('unpublished local created plugin shows publish', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: null,
        canPublish: false,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: 'publish',
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: true,
    })
  })

  test('personal owner keeps access in section and publish new version in menu', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: { accessRole: 'owner', visibility: 'personal' },
        canPublish: true,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: true,
      canManageAccess: true,
      canOpenPublishDialog: true,
    })
  })

  test('personal owner shows publish new version before local package hydrates', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'owner', visibility: 'personal' },
        canPublish: true,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: true,
      canManageAccess: true,
      canOpenPublishDialog: true,
    })
  })

  test('personal owner with only personal-share capability shows publish new version in menu', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'owner', visibility: 'personal' },
        canPublish: false,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: true,
      canManageAccess: true,
      canOpenPublishDialog: true,
    })
  })

  test('workspace owner shows publish new version in the header without waiting for local package', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'owner', visibility: 'workspace' },
        canPublish: true,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: 'publishNewVersion',
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: true,
    })
  })

  test('workspace owner with only personal-share capability cannot republish', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'owner', visibility: 'workspace' },
        canPublish: false,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: false,
    })
  })

  test('public owner shows publish new version in the header', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: { accessRole: 'owner', visibility: 'public' },
        canPublish: true,
        canSharePersonalPlugins: false,
      })
    ).toEqual({
      headerAction: 'publishNewVersion',
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: true,
    })
  })

  test('recipient or catalog never gets owner publish or share actions', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: { accessRole: 'recipient', visibility: 'personal' },
        canPublish: true,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: 'publish',
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: true,
    })

    expect(
      resolvePluginOwnerActions({
        isLocalCreated: false,
        ownedListing: { accessRole: 'catalog', visibility: 'public' },
        canPublish: true,
        canSharePersonalPlugins: true,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: false,
    })
  })

  test('without publish capabilities local created plugin has no actions', () => {
    expect(
      resolvePluginOwnerActions({
        isLocalCreated: true,
        ownedListing: null,
        canPublish: false,
        canSharePersonalPlugins: false,
      })
    ).toEqual({
      headerAction: null,
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: false,
    })
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
