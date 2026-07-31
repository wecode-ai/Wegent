// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { modelApis } from '@/apis/models'
import { retrieverApis } from '@/apis/retrievers'
import { shellApis } from '@/apis/shells'
import { fetchUnifiedSkillsList } from '@/apis/skills'
import { teamApis } from '@/apis/team'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ResourceLibraryTypeFilter, VisibleResourceLibraryResourceType } from '../types'

interface PublishResourceDialogProps {
  open: boolean
  resourceType: ResourceLibraryTypeFilter
  initialSourceId?: number
  onOpenChange: (open: boolean) => void
  onPublished: () => void
}

const publishableResourceTypes: VisibleResourceLibraryResourceType[] = [
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
]

interface PublishableResource {
  key: string
  id?: number
  name: string
  namespace: string
  displayName: string
  description: string
  version: string
}

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
}

function defaultPublishType(
  resourceType: ResourceLibraryTypeFilter
): VisibleResourceLibraryResourceType {
  return publishableResourceTypes.includes(resourceType as VisibleResourceLibraryResourceType)
    ? (resourceType as VisibleResourceLibraryResourceType)
    : 'agent'
}

export function PublishResourceDialog({
  open,
  resourceType,
  initialSourceId,
  onOpenChange,
  onPublished,
}: PublishResourceDialogProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [selectedType, setSelectedType] = useState<VisibleResourceLibraryResourceType>(
    defaultPublishType(resourceType)
  )
  const [sourceId, setSourceId] = useState('')
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [isPublishing, setIsPublishing] = useState(false)
  const [resources, setResources] = useState<PublishableResource[]>([])
  const [isLoadingResources, setIsLoadingResources] = useState(false)

  useEffect(() => {
    if (open) {
      setSelectedType(defaultPublishType(resourceType))
    }
  }, [open, resourceType])

  useEffect(() => {
    if (!open) return
    let active = true
    setIsLoadingResources(true)
    setSourceId('')

    const request: Promise<PublishableResource[]> = (() => {
      if (selectedType === 'agent') {
        return teamApis.getTeams({ page: 1, limit: 100 }, 'personal').then(response =>
          response.items.map(team => ({
            key: String(team.id),
            id: team.id,
            name: team.name,
            namespace: 'default',
            displayName: team.displayName || team.name,
            description: team.description || '',
            version: '1.0.0',
          }))
        )
      }
      if (selectedType === 'skill') {
        return fetchUnifiedSkillsList({ skip: 0, limit: 100, scope: 'personal' }).then(skills =>
          skills.map(skill => ({
            key: String(skill.id),
            id: skill.id,
            name: skill.name,
            namespace: skill.namespace || 'default',
            displayName: skill.displayName || skill.name,
            description: skill.description || '',
            version: skill.version || '1.0.0',
          }))
        )
      }
      if (selectedType === 'model') {
        return modelApis.getUnifiedModels(undefined, false, 'personal').then(response =>
          response.data
            .filter(model => model.type === 'user')
            .map(model => ({
              key: `${model.namespace || 'default'}:${model.name}`,
              name: model.name,
              namespace: model.namespace || 'default',
              displayName: model.displayName || model.name,
              description: '',
              version: '1.0.0',
            }))
        )
      }
      if (selectedType === 'shell') {
        return shellApis.getUnifiedShells('personal').then(response =>
          response.data
            .filter(shell => shell.type === 'user')
            .map(shell => ({
              key: `${shell.namespace || 'default'}:${shell.name}`,
              name: shell.name,
              namespace: shell.namespace || 'default',
              displayName: shell.displayName || shell.name,
              description: '',
              version: '1.0.0',
            }))
        )
      }
      return retrieverApis.getUnifiedRetrievers('personal').then(response =>
        response.data
          .filter(retriever => retriever.type === 'user')
          .map(retriever => ({
            key: `${retriever.namespace || 'default'}:${retriever.name}`,
            name: retriever.name,
            namespace: retriever.namespace || 'default',
            displayName: retriever.displayName || retriever.name,
            description: retriever.description || '',
            version: '1.0.0',
          }))
      )
    })()

    request
      .then(items => {
        if (!active) return
        setResources(items)
        const selected = items.find(resource => resource.id === initialSourceId)
        if (selected) {
          setSourceId(selected.key)
          setName(selected.name)
          setDisplayName(selected.displayName)
          setDescription(selected.description)
          setVersion(selected.version)
        }
      })
      .catch(() => {
        if (active) setResources([])
      })
      .finally(() => {
        if (active) setIsLoadingResources(false)
      })

    return () => {
      active = false
    }
  }, [initialSourceId, open, selectedType])

  const canPublish = useMemo(() => {
    return Boolean(sourceId && name.trim() && displayName.trim() && version.trim())
  }, [displayName, name, sourceId, version])

  const resetForm = () => {
    setSourceId('')
    setName('')
    setDisplayName('')
    setDescription('')
    setTags('')
    setVersion('1.0.0')
  }

  const handleResourceChange = (value: string) => {
    setSourceId(value)
    const selected = resources.find(resource => resource.key === value)
    if (!selected) return
    setName(selected.name)
    setDisplayName(selected.displayName)
    setDescription(selected.description)
    setVersion(selected.version)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canPublish || isPublishing) {
      return
    }

    setIsPublishing(true)
    try {
      const selected = resources.find(resource => resource.key === sourceId)
      if (!selected) return
      await resourceLibraryApi.createListing({
        resource_type: selectedType,
        source_id: selected.id,
        source_name: selected.id ? undefined : selected.name,
        source_namespace: selected.namespace,
        name: name.trim(),
        display_name: displayName.trim(),
        description: description.trim() || null,
        icon: null,
        tags: parseTags(tags),
        version: version.trim(),
        manifest_options: {},
      })
      toast({ title: t('messages.publish_success') })
      resetForm()
      onOpenChange(false)
      onPublished()
    } catch (error) {
      toast({
        title: t('messages.publish_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsPublishing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="publish-resource-dialog">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('actions.publish')}</DialogTitle>
            <DialogDescription>{t('publish.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('fields.type')}>
            {publishableResourceTypes.map(type => (
              <Button
                key={type}
                type="button"
                variant={selectedType === type ? 'primary' : 'outline'}
                className={cn('h-11 min-w-[44px]', selectedType === type && 'border-primary')}
                onClick={() => setSelectedType(type)}
                aria-pressed={selectedType === type}
                data-testid={`publish-resource-type-${type}-button`}
              >
                {t(`filters.${type}`)}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="resource-library-source-id">{t('fields.source_id')}</Label>
              <select
                id="resource-library-source-id"
                value={sourceId}
                onChange={event => handleResourceChange(event.target.value)}
                className="h-11 w-full rounded-md border border-border bg-base px-3 text-sm"
                data-testid="publish-resource-source-id-input"
                disabled={isLoadingResources}
              >
                <option value="">{t('publish.select_resource')}</option>
                {resources.map(resource => (
                  <option key={resource.key} value={resource.key}>
                    {resource.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resource-library-version">{t('fields.version')}</Label>
              <Input
                id="resource-library-version"
                value={version}
                onChange={event => setVersion(event.target.value)}
                className="h-11"
                data-testid="publish-resource-version-input"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-name">{t('fields.name')}</Label>
            <Input
              id="resource-library-name"
              value={name}
              onChange={event => setName(event.target.value)}
              className="h-11"
              data-testid="publish-resource-name-input"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-display-name">{t('fields.display_name')}</Label>
            <Input
              id="resource-library-display-name"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              className="h-11"
              data-testid="publish-resource-display-name-input"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-description">{t('fields.description')}</Label>
            <Textarea
              id="resource-library-description"
              value={description}
              onChange={event => setDescription(event.target.value)}
              data-testid="publish-resource-description-textarea"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-tags">{t('fields.tags')}</Label>
            <Input
              id="resource-library-tags"
              value={tags}
              onChange={event => setTags(event.target.value)}
              className="h-11"
              data-testid="publish-resource-tags-input"
            />
          </div>

          <DialogFooter className="gap-2 sm:space-x-0">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[44px]"
                data-testid="publish-resource-cancel-button"
              >
                {t('actions.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              className="h-11 min-w-[44px]"
              disabled={!canPublish || isPublishing}
              data-testid="publish-resource-submit-button"
            >
              {t('actions.publish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
