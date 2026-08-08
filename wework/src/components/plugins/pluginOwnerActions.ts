export type PluginOwnerHeaderAction = 'publish' | 'publishNewVersion' | null

export interface PluginOwnerListingRef {
  accessRole?: 'catalog' | 'owner' | 'recipient' | null
  visibility?: 'personal' | 'workspace' | 'public' | null
}

export interface PluginOwnerActionsInput {
  isLocalCreated: boolean
  ownedListing: PluginOwnerListingRef | null
  canPublish: boolean
  canSharePersonalPlugins: boolean
}

export interface PluginOwnerActions {
  headerAction: PluginOwnerHeaderAction
  showPublishNewVersionInMenu: boolean
  canManageAccess: boolean
  canOpenPublishDialog: boolean
}

/**
 * Decide owner-facing publish / access actions for plugin detail and lists.
 * Access management lives in the availability section; publish submits a versioned package.
 */
export function resolvePluginOwnerActions(input: PluginOwnerActionsInput): PluginOwnerActions {
  const hasPublishCapability = input.canPublish || input.canSharePersonalPlugins
  const canPackagePublish = input.isLocalCreated && hasPublishCapability
  const isOwner = input.ownedListing?.accessRole === 'owner'
  const visibility = input.ownedListing?.visibility ?? null

  if (!isOwner) {
    return {
      headerAction: canPackagePublish ? 'publish' : null,
      showPublishNewVersionInMenu: false,
      canManageAccess: false,
      canOpenPublishDialog: canPackagePublish,
    }
  }

  if (visibility === 'personal') {
    // Personal owners already have a cloud listing. Show republish as soon as
    // capabilities allow — do not wait for the local created install row to hydrate.
    // Click handlers still resolve a packable local target (or surface an error).
    return {
      // Keep access management in the availability section only — no redundant header CTA.
      headerAction: null,
      showPublishNewVersionInMenu: hasPublishCapability,
      canManageAccess: true,
      canOpenPublishDialog: hasPublishCapability,
    }
  }

  // Workspace/public republish requires org publish capability; personal-share alone is not enough.
  return {
    headerAction: input.canPublish ? 'publishNewVersion' : null,
    showPublishNewVersionInMenu: false,
    canManageAccess: false,
    canOpenPublishDialog: input.canPublish,
  }
}

export function canRecoverShareAfterVersionConflict(
  ownedListing: PluginOwnerListingRef | null
): boolean {
  return ownedListing?.accessRole === 'owner' && ownedListing.visibility === 'personal'
}
