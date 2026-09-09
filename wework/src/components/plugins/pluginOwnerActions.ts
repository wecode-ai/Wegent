export interface PluginOwnerListingRef {
  accessRole?: 'catalog' | 'owner' | 'recipient' | null
  visibility?: 'personal' | 'workspace' | 'public' | null
}

export interface PluginOwnerActionsInput {
  isLocalCreated: boolean
  ownedListing: PluginOwnerListingRef | null
}

export interface PluginOwnerActions {
  showShareAction: boolean
  canManageAccess: boolean
}

/**
 * Decide owner-facing publish / access actions for plugin detail and lists.
 * Access management lives in the availability section; publish submits a versioned package.
 */
export function resolvePluginOwnerActions(input: PluginOwnerActionsInput): PluginOwnerActions {
  const isOwner = input.ownedListing?.accessRole === 'owner'
  const canPackageShare = input.isLocalCreated && input.ownedListing === null
  const visibility = input.ownedListing?.visibility ?? null

  if (!isOwner) {
    return {
      showShareAction: canPackageShare,
      canManageAccess: false,
    }
  }

  if (visibility === 'personal') {
    // Personal owners already have a cloud listing. Keep sharing available without
    // waiting for the local created install row to hydrate.
    // Click handlers still resolve a packable local target (or surface an error).
    return {
      showShareAction: true,
      canManageAccess: true,
    }
  }

  // Enterprise catalog releases advance through the reviewed version workflow,
  // not through the personal owner share dialog.
  return {
    showShareAction: false,
    canManageAccess: false,
  }
}

export function canRecoverShareAfterVersionConflict(
  ownedListing: PluginOwnerListingRef | null
): boolean {
  return ownedListing?.accessRole === 'owner' && ownedListing.visibility === 'personal'
}
