// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Represents a Ghost that references a Skill
 */
export interface ReferencedGhost {
  id: number
  name: string
  namespace: string
}

/**
 * Structured error response when skill deletion fails due to references
 */
export interface SkillReferenceError {
  code: 'SKILL_REFERENCED'
  message: string
  skill_name: string
  referenced_ghosts: ReferencedGhost[]
}

interface SkillReferenceConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skillName: string
  skillId: number
  referencedGhosts: ReferencedGhost[]
  onRemoveAllReferences: () => Promise<void>
  onRemoveSingleReference: (ghostId: number) => Promise<void>
  onDeleteSuccess: () => void
}

/**
 * Dialog component that displays when a skill cannot be deleted
 * because it is referenced by one or more Ghosts.
 *
 * Provides options to:
 * - View the list of referencing Ghosts
 * - Edit individual Ghosts to remove the reference
 * - Remove reference from a single Ghost
 * - Remove all references at once and delete the skill
 */
export function SkillReferenceConflictDialog({
  open,
  onOpenChange,
  skillName,
  skillId: _skillId,
  referencedGhosts,
  onRemoveAllReferences,
  onRemoveSingleReference,
  onDeleteSuccess,
}: SkillReferenceConflictDialogProps) {
  const { t } = useTranslation('common')
  const [removingAll, setRemovingAll] = useState(false)
  const [removingGhostId, setRemovingGhostId] = useState<number | null>(null)
  const [localGhosts, setLocalGhosts] = useState<ReferencedGhost[]>(referencedGhosts)

  // Update local ghosts when props change
  if (referencedGhosts !== localGhosts && referencedGhosts.length > 0) {
    setLocalGhosts(referencedGhosts)
  }

  const handleRemoveAll = async () => {
    try {
      setRemovingAll(true)
      await onRemoveAllReferences()
      toast.success(t('skills.references_removed_success'))
      onDeleteSuccess()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('skills.references_remove_failed'))
    } finally {
      setRemovingAll(false)
    }
  }

  const handleRemoveSingle = async (ghost: ReferencedGhost) => {
    try {
      setRemovingGhostId(ghost.id)
      await onRemoveSingleReference(ghost.id)
      // Remove from local list
      const newGhosts = localGhosts.filter(g => g.id !== ghost.id)
      setLocalGhosts(newGhosts)
      toast.success(t('skills.reference_removed_success', { ghostName: ghost.name }))

      // If no more references, close dialog and trigger delete
      if (newGhosts.length === 0) {
        onDeleteSuccess()
        onOpenChange(false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('skills.reference_remove_failed'))
    } finally {
      setRemovingGhostId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600">
            <AlertTriangle className="h-5 w-5" />
            {t('skills.cannot_delete_title')}
          </DialogTitle>
          <DialogDescription>
            {t('skills.cannot_delete_description', { skillName })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <p className="text-sm text-text-secondary mb-3">
            {t('skills.referenced_by_ghosts', { count: localGhosts.length })}
          </p>

          <ScrollArea className="max-h-[200px] rounded-md border border-border">
            <div className="p-2 space-y-2">
              {localGhosts.map(ghost => (
                <div
                  key={ghost.id}
                  className="flex items-center justify-between p-2 rounded-md bg-surface hover:bg-muted transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{ghost.name}</span>
                    {ghost.namespace !== 'default' && (
                      <span className="text-xs text-text-muted">({ghost.namespace})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveSingle(ghost)}
                      disabled={removingGhostId === ghost.id || removingAll}
                      title={t('skills.remove_reference')}
                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                    >
                      {removingGhostId === ghost.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          <div className="mt-4 p-3 bg-muted rounded-md">
            <p className="text-sm text-text-secondary">{t('skills.reference_conflict_help')}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={removingAll}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleRemoveAll}
            disabled={removingAll || removingGhostId !== null}
          >
            {removingAll ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('skills.removing_references')}
              </>
            ) : (
              t('skills.remove_all_and_delete')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Helper function to check if an error is a skill reference error
 */
export function isSkillReferenceError(error: unknown): error is { detail: SkillReferenceError } {
  if (typeof error !== 'object' || error === null) return false
  const err = error as { detail?: unknown }
  if (typeof err.detail !== 'object' || err.detail === null) return false
  const detail = err.detail as { code?: string }
  return detail.code === 'SKILL_REFERENCED'
}

/**
 * Helper function to parse skill reference error from API response
 */
export function parseSkillReferenceError(errorMessage: string): SkillReferenceError | null {
  try {
    const parsed = JSON.parse(errorMessage)
    if (parsed.code === 'SKILL_REFERENCED') {
      return parsed as SkillReferenceError
    }
    // Handle nested detail structure
    if (
      parsed.detail &&
      typeof parsed.detail === 'object' &&
      parsed.detail.code === 'SKILL_REFERENCED'
    ) {
      return parsed.detail as SkillReferenceError
    }
  } catch {
    // Not a JSON error, try to extract from string
  }
  return null
}
