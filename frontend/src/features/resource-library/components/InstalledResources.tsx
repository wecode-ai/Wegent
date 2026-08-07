// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, MoreHorizontal, Pencil, RefreshCw, Settings2, Unlink } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import {
  fetchMyDefaultSkillBindings,
  removeSkillFromMyDefault,
  type SkillBinding,
  type UnifiedSkill,
} from '@/apis/skills'
import { getResourceGridClassName } from '@/components/common/resourceCardLayout'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Skeleton } from '@/components/ui/skeleton'
import { buildChatCodeHref } from '@/config/coding-route'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { canEditContent } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ResourceLibraryInstall, ResourceLibraryListing } from '../types'
import type { ResourceListState } from '@/features/settings/components/SkillListWithScope'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'
import { AutoEnabledSkillConfigDialog } from '@/features/settings/components/skills/AutoEnabledSkillConfigDialog'
import SkillUploadModal from '@/features/settings/components/skills/SkillUploadModal'

type InstalledResourceType = 'agent' | 'skill'

const INSTALLS_PAGE_LIMIT = 100

interface InstalledResourcesProps {
  resourceType: InstalledResourceType
  keyword?: string
  groupNamespaces?: string[]
  excludeGroupOwned?: boolean
  groups?: Group[]
  hideLoadingState?: boolean
  hideEmptyState?: boolean
  onListStateChange?: (state: ResourceListState) => void
}

interface InstalledResource extends ResourceLibraryInstall {
  listing: ResourceLibraryListing
}

function hasInstalledListing(install: ResourceLibraryInstall): install is InstalledResource {
  return install.install_status === 'installed' && Boolean(install.listing)
}

function isGroupOwnedSkill(install: ResourceLibraryInstall): boolean {
  return (
    install.resource_type === 'skill' &&
    (install.installed_reference.ownership === 'group' ||
      install.installed_reference.kind === 'Skill' ||
      (Boolean(install.installed_reference.namespace) &&
        install.installed_reference.kind !== 'SkillBinding'))
  )
}

function normalizeInstalls(
  items: ResourceLibraryInstall[],
  excludeGroupOwned = false
): InstalledResource[] {
  const installsByListingId = new Map<number, InstalledResource>()

  items.filter(hasInstalledListing).forEach(install => {
    if (excludeGroupOwned && isGroupOwnedSkill(install)) return
    if (installsByListingId.has(install.listing.id)) return

    installsByListingId.set(install.listing.id, {
      ...install,
      listing: {
        ...install.listing,
        is_installed: true,
      },
    })
  })

  return Array.from(installsByListingId.values())
}

function matchesKeyword(listing: ResourceLibraryListing, keyword: string): boolean {
  if (!keyword) return true

  return [listing.name, listing.display_name, listing.description].some(value =>
    value?.toLowerCase().includes(keyword)
  )
}

function buildAgentUseHref(listing: ResourceLibraryListing, teamId: number): string {
  const isCodeOnlyAgent = listing.bind_modes.length === 1 && listing.bind_modes.includes('code')
  if (!isCodeOnlyAgent) {
    return `/chat?teamId=${teamId}`
  }

  return buildChatCodeHref(
    new URLSearchParams([
      ['agent', 'code'],
      ['teamId', String(teamId)],
    ])
  )
}

function buildConfigurableSkill(install: InstalledResource, binding?: SkillBinding): UnifiedSkill {
  const { listing } = install
  const skillId = install.installed_reference.skill_id ?? listing.id

  return {
    id: skillId,
    name: binding?.skill_ref.name || install.installed_reference.name || listing.name,
    namespace: binding?.skill_ref.namespace || install.installed_reference.namespace || 'default',
    description: listing.description || '',
    displayName: listing.display_name,
    version: listing.current_version?.version,
    tags: listing.tags,
    is_active: true,
    is_public: binding?.skill_ref.is_public ?? listing.publisher_user_id === 0,
    user_id: listing.publisher_user_id,
    availability: { inMyDefault: true },
    created_at: listing.created_at,
    updated_at: listing.updated_at,
  }
}

function buildEditableGroupSkill(install: InstalledResource): UnifiedSkill {
  const { listing, installed_reference: reference } = install
  return {
    id: reference.skill_id ?? listing.id,
    name: reference.name || listing.name,
    namespace: reference.namespace || 'default',
    description: listing.description || '',
    displayName: listing.display_name,
    version: listing.current_version?.version,
    tags: listing.tags,
    is_active: true,
    is_public: false,
    user_id: install.user_id,
    availability: { inMyDefault: false },
    created_at: listing.created_at,
    updated_at: listing.updated_at,
  }
}

async function loadAllInstallPages(
  loadPage: (page: number) => Promise<{ items: ResourceLibraryInstall[]; total: number }>
): Promise<ResourceLibraryInstall[]> {
  const installs: ResourceLibraryInstall[] = []
  let page = 1

  while (true) {
    const response = await loadPage(page)
    if (response.items.length === 0) break

    installs.push(...response.items)
    if (installs.length >= response.total) break

    page += 1
  }

  return installs
}

export function InstalledResources({
  resourceType,
  keyword,
  groupNamespaces,
  excludeGroupOwned = false,
  groups = [],
  hideLoadingState = false,
  hideEmptyState = false,
  onListStateChange,
}: InstalledResourcesProps) {
  const router = useRouter()
  const { t } = useTranslation('resource-library')
  const { t: tSettings } = useTranslation('settings')
  const { toast } = useToast()
  const { user } = useUser()
  const [installs, setInstalls] = useState<InstalledResource[]>([])
  const [skillBindings, setSkillBindings] = useState<SkillBinding[]>([])
  const [configuringSkill, setConfiguringSkill] = useState<UnifiedSkill | null>(null)
  const [editingGroupSkill, setEditingGroupSkill] = useState<InstalledResource | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [selectedListing, setSelectedListing] = useState<ResourceLibraryListing | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<InstalledResource | null>(null)
  const [removingInstallId, setRemovingInstallId] = useState<number | null>(null)
  const requestGenerationRef = useRef(0)
  const isGroupMode = groupNamespaces !== undefined
  const groupNamespacesKey = Array.from(
    new Set((groupNamespaces || []).map(namespace => namespace.trim()).filter(Boolean))
  ).join('\u0000')

  const loadInstalls = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current
    setIsLoading(true)
    setHasError(false)

    try {
      const selectedGroupNamespaces = groupNamespacesKey ? groupNamespacesKey.split('\u0000') : []
      const [items, bindings] = await Promise.all([
        isGroupMode
          ? selectedGroupNamespaces.length > 0
            ? loadAllInstallPages(page =>
                resourceLibraryApi.listGroupInstallsBatch(selectedGroupNamespaces, {
                  resourceType,
                  page,
                  limit: INSTALLS_PAGE_LIMIT,
                })
              )
            : []
          : loadAllInstallPages(page =>
              resourceLibraryApi.listMyInstalls({
                resourceType,
                page,
                limit: INSTALLS_PAGE_LIMIT,
              })
            ),
        !isGroupMode && resourceType === 'skill'
          ? fetchMyDefaultSkillBindings()
          : Promise.resolve([]),
      ])

      if (requestGeneration === requestGenerationRef.current) {
        setInstalls(normalizeInstalls(items, excludeGroupOwned))
        setSkillBindings(bindings)
      }
    } catch {
      if (requestGeneration === requestGenerationRef.current) {
        setInstalls([])
        setHasError(true)
      }
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setIsLoading(false)
      }
    }
  }, [excludeGroupOwned, groupNamespacesKey, isGroupMode, resourceType])

  useEffect(() => {
    void loadInstalls()

    return () => {
      requestGenerationRef.current += 1
    }
  }, [loadInstalls])

  const filteredInstalls = useMemo(() => {
    const normalizedKeyword = keyword?.trim().toLowerCase() || ''
    return installs.filter(install => matchesKeyword(install.listing, normalizedKeyword))
  }, [installs, keyword])

  useEffect(() => {
    onListStateChange?.({
      loading: isLoading,
      hasItems: filteredInstalls.length > 0,
      hasError,
    })
  }, [filteredInstalls.length, hasError, isLoading, onListStateChange])

  const handleUse = (listing: ResourceLibraryListing) => {
    if (listing.resource_type !== 'agent') return

    const install = installs.find(item => item.listing.id === listing.id)
    const teamId = install?.installed_reference.team_id
    if (typeof teamId === 'number') {
      router.push(buildAgentUseHref(listing, teamId))
    }
  }

  const handleViewDetails = (listing: ResourceLibraryListing) => {
    setSelectedListing(listing)
    setIsDetailOpen(true)
  }

  const handleRemoveAddedResource = async () => {
    if (!pendingRemoval) return

    const install = pendingRemoval
    const isAgent = install.listing.resource_type === 'agent'
    setRemovingInstallId(install.id)

    try {
      if (isAgent) {
        await resourceLibraryApi.uninstallListing(install.listing.id, 'default')
      } else {
        const skillId = install.installed_reference.skill_id ?? install.listing.id
        await removeSkillFromMyDefault(skillId)
        setSkillBindings(current =>
          current.filter(binding => binding.skill_ref.skill_id !== skillId)
        )
      }
      setInstalls(current => current.filter(item => item.id !== install.id))
      setPendingRemoval(null)
      toast({
        title: t(
          isAgent ? 'messages.remove_added_agent_success' : 'messages.remove_added_skill_success'
        ),
      })
    } catch (error) {
      toast({
        title: t(
          isAgent ? 'messages.remove_added_agent_failed' : 'messages.remove_added_skill_failed'
        ),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRemovingInstallId(null)
    }
  }

  const handleConfigureAddedSkill = (install: InstalledResource) => {
    const skillId = install.installed_reference.skill_id ?? install.listing.id
    const binding = skillBindings.find(item => item.skill_ref.skill_id === skillId)
    setConfiguringSkill(buildConfigurableSkill(install, binding))
  }

  const handleBindingChange = (binding: SkillBinding) => {
    setSkillBindings(current => {
      const index = current.findIndex(
        item => item.skill_ref.skill_id === binding.skill_ref.skill_id
      )
      if (index === -1) return [...current, binding]

      return current.map(item =>
        item.skill_ref.skill_id === binding.skill_ref.skill_id ? binding : item
      )
    })
  }

  if (isLoading) {
    if (hideLoadingState) return null

    return (
      <div
        className={getResourceGridClassName(true)}
        aria-label={t('states.loading')}
        data-testid="installed-resources-loading"
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-[180px] rounded-lg" />
        ))}
      </div>
    )
  }

  if (hasError) {
    return (
      <div
        className="flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface p-6 text-center"
        data-testid="installed-resources-error"
      >
        <p className="text-sm text-text-secondary">{t('states.error')}</p>
        <Button
          type="button"
          variant="outline"
          className="h-11 min-w-[44px]"
          onClick={() => void loadInstalls()}
          data-testid="installed-resources-retry-button"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('actions.retry')}
        </Button>
      </div>
    )
  }

  if (filteredInstalls.length === 0) {
    if (hideEmptyState) return null

    return (
      <div
        className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface p-6 text-sm text-text-secondary"
        data-testid="installed-resources-empty"
      >
        {t('states.empty')}
      </div>
    )
  }

  return (
    <>
      <div className={getResourceGridClassName(true)} data-testid="installed-resources-grid">
        {filteredInstalls.map(install => {
          const title = install.listing.display_name || install.listing.name
          const isRemoving = removingInstallId === install.id
          const group = groups.find(item => item.name === install.installed_reference.namespace)
          const canEditGroupSkill =
            isGroupMode &&
            resourceType === 'skill' &&
            (user?.role === 'admin' ||
              String(install.listing.publisher_user_id) === String(user?.id) ||
              canEditContent(group?.my_role))
          const removalAction = !isGroupMode ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                  aria-label={t('actions.more')}
                  data-testid={`installed-resource-actions-${resourceType}-${install.id}`}
                >
                  <MoreHorizontal className="h-5 w-5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  danger
                  onSelect={() => setPendingRemoval(install)}
                  disabled={isRemoving}
                  data-testid={`remove-installed-${resourceType}-${install.id}-button`}
                >
                  <Unlink className="mr-2 h-4 w-4" aria-hidden />
                  {t(
                    resourceType === 'agent'
                      ? 'actions.remove_added_agent'
                      : 'actions.remove_added_skill'
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null

          return (
            <ResourceListingCard
              key={install.id}
              listing={install.listing}
              onInstall={handleUse}
              onViewDetails={handleViewDetails}
              compact={resourceType === 'skill'}
              presentation="management"
              managementFooterAction={
                resourceType === 'skill' ? (
                  <div className="flex gap-2">
                    {canEditGroupSkill && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-11 min-w-0 flex-1 gap-1.5 text-xs md:h-8"
                        disabled={isRemoving}
                        onClick={() => setEditingGroupSkill(install)}
                        aria-label={`${t('actions.edit')} ${title}`}
                        data-testid={`edit-shared-skill-${install.id}-button`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t('actions.edit')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-11 min-w-0 flex-1 gap-1.5 text-xs md:h-8"
                      disabled={isRemoving}
                      onClick={() =>
                        isGroupMode
                          ? handleViewDetails(install.listing)
                          : handleConfigureAddedSkill(install)
                      }
                      aria-label={`${isGroupMode ? t('actions.details') : tSettings('skills.autoSettings.configure')} ${title}`}
                      data-testid={
                        isGroupMode
                          ? `view-shared-skill-${install.id}-button`
                          : `configure-added-skill-${install.id}-button`
                      }
                    >
                      {isGroupMode ? (
                        <Eye className="h-4 w-4" aria-hidden />
                      ) : (
                        <Settings2 className="h-4 w-4" aria-hidden />
                      )}
                      {isGroupMode
                        ? t('actions.details')
                        : tSettings('skills.autoSettings.configure')}
                    </Button>
                    {removalAction}
                  </div>
                ) : (
                  removalAction
                )
              }
            />
          )
        })}
      </div>

      <ResourceDetailDrawer
        open={isDetailOpen}
        listing={selectedListing}
        onOpenChange={setIsDetailOpen}
        onInstall={handleUse}
      />

      {resourceType === 'skill' && !isGroupMode && (
        <AutoEnabledSkillConfigDialog
          open={Boolean(configuringSkill)}
          onOpenChange={open => {
            if (!open) setConfiguringSkill(null)
          }}
          skill={configuringSkill}
          binding={skillBindings.find(
            binding => binding.skill_ref.skill_id === configuringSkill?.id
          )}
          onBindingChange={handleBindingChange}
        />
      )}

      {editingGroupSkill && (
        <SkillUploadModal
          open
          skill={buildEditableGroupSkill(editingGroupSkill)}
          namespace={editingGroupSkill.installed_reference.namespace}
          onClose={saved => {
            setEditingGroupSkill(null)
            if (saved) void loadInstalls()
          }}
        />
      )}

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={open => {
          if (!open && removingInstallId === null) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                pendingRemoval?.listing.resource_type === 'agent'
                  ? 'actions.remove_added_agent'
                  : 'actions.remove_added_skill'
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemoval?.listing.resource_type === 'agent'
                ? t('messages.remove_added_agent_confirm', {
                    agent:
                      pendingRemoval?.listing.display_name || pendingRemoval?.listing.name || '',
                  })
                : t('messages.remove_added_skill_confirm', {
                    skill:
                      pendingRemoval?.listing.display_name || pendingRemoval?.listing.name || '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={removingInstallId !== null}
              onClick={() => setPendingRemoval(null)}
              data-testid="cancel-remove-installed-resource-button"
            >
              {t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-error text-white hover:bg-error/90"
              disabled={removingInstallId !== null}
              onClick={event => {
                event.preventDefault()
                void handleRemoveAddedResource()
              }}
              data-testid={`confirm-remove-installed-${pendingRemoval?.listing.resource_type || resourceType}-button`}
            >
              {t(
                pendingRemoval?.listing.resource_type === 'agent'
                  ? 'actions.remove_added_agent'
                  : 'actions.remove_added_skill'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
