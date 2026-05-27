// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
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
import type { ResourceLibraryResourceType, ResourceLibraryTypeFilter } from '../types'

interface PublishResourceDialogProps {
  open: boolean
  resourceType: ResourceLibraryTypeFilter
  onOpenChange: (open: boolean) => void
  onPublished: () => void
}

const publishableResourceTypes: ResourceLibraryResourceType[] = ['agent', 'skill', 'mcp']

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
}

function defaultPublishType(resourceType: ResourceLibraryTypeFilter): ResourceLibraryResourceType {
  return resourceType === 'all' ? 'agent' : resourceType
}

export function PublishResourceDialog({
  open,
  resourceType,
  onOpenChange,
  onPublished,
}: PublishResourceDialogProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [selectedType, setSelectedType] = useState<ResourceLibraryResourceType>(
    defaultPublishType(resourceType)
  )
  const [sourceId, setSourceId] = useState('')
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [isPublishing, setIsPublishing] = useState(false)

  useEffect(() => {
    if (open) {
      setSelectedType(defaultPublishType(resourceType))
    }
  }, [open, resourceType])

  const canPublish = useMemo(() => {
    return Boolean(Number(sourceId) > 0 && name.trim() && displayName.trim() && version.trim())
  }, [displayName, name, sourceId, version])

  const resetForm = () => {
    setSourceId('')
    setName('')
    setDisplayName('')
    setDescription('')
    setTags('')
    setVersion('1.0.0')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canPublish || isPublishing) {
      return
    }

    setIsPublishing(true)
    try {
      await resourceLibraryApi.createListing({
        resource_type: selectedType,
        source_id: Number(sourceId),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
              >
                {t(`filters.${type}`)}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="resource-library-source-id">{t('fields.source_id')}</Label>
              <Input
                id="resource-library-source-id"
                value={sourceId}
                onChange={event => setSourceId(event.target.value)}
                inputMode="numeric"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resource-library-version">{t('fields.version')}</Label>
              <Input
                id="resource-library-version"
                value={version}
                onChange={event => setVersion(event.target.value)}
                className="h-11"
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
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-display-name">{t('fields.display_name')}</Label>
            <Input
              id="resource-library-display-name"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-description">{t('fields.description')}</Label>
            <Textarea
              id="resource-library-description"
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-library-tags">{t('fields.tags')}</Label>
            <Input
              id="resource-library-tags"
              value={tags}
              onChange={event => setTags(event.target.value)}
              className="h-11"
            />
          </div>

          <DialogFooter className="gap-2 sm:space-x-0">
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-11 min-w-[44px]">
                {t('actions.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              className="h-11 min-w-[44px]"
              disabled={!canPublish || isPublishing}
            >
              {t('actions.publish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
