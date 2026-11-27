// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  getModelPrimaryGroupIcons,
  setModelPrimaryGroupIcon,
  type ModelPrimaryGroupIcons,
} from '@/apis/model-primary-group-icons'
import {
  ModelPrimaryGroupIcon,
  modelPrimaryGroupIconChoices,
} from '@/components/model-select/ModelPrimaryGroupIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export function ModelPrimaryGroupIconSettings({ groups }: { groups: string[] }) {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [icons, setIcons] = useState<ModelPrimaryGroupIcons>()
  const [group, setGroup] = useState('')
  const [draftIcon, setDraftIcon] = useState<string>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const groupName = group.trim()
  const savedIcon = icons && Object.hasOwn(icons, groupName) ? icons[groupName] : ''
  const icon = draftIcon ?? savedIcon
  const groupNames = [...new Set([...groups, ...Object.keys(icons ?? {})])].sort()

  async function loadIcons() {
    setLoadFailed(false)
    setIcons(undefined)
    try {
      setIcons(await getModelPrimaryGroupIcons())
    } catch {
      setLoadFailed(true)
    }
  }

  async function saveIcon() {
    if (!groupName || saving || !icons) return
    setSaving(true)
    try {
      await setModelPrimaryGroupIcon(groupName, icon || null)
      const next = { ...icons, [groupName]: icon }
      if (!icon) delete next[groupName]
      setIcons(next)
      setDraftIcon(undefined)
      toast({ title: t('model_group_icons.saved') })
    } catch {
      toast({ title: t('model_group_icons.save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (open) {
          setGroup('')
          setDraftIcon(undefined)
          void loadIcons()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="model-group-icons-open">
          {t('model_group_icons.title')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault()
            void saveIcon()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('model_group_icons.title')}</DialogTitle>
            <DialogDescription>{t('model_group_icons.description')}</DialogDescription>
          </DialogHeader>
          {loadFailed ? (
            <div className="flex items-center justify-between gap-2" role="alert">
              {t('model_group_icons.load_failed')}
              <Button
                type="button"
                variant="outline"
                onClick={loadIcons}
                data-testid="model-group-icons-retry"
              >
                {t('model_group_icons.retry')}
              </Button>
            </div>
          ) : !icons ? (
            <p role="status" className="text-sm text-text-muted">
              {t('model_group_icons.loading')}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="model-group-icon-group">{t('model_group_icons.group')}</Label>
                <Input
                  id="model-group-icon-group"
                  data-testid="model-group-icon-group"
                  list="model-group-icon-groups"
                  value={group}
                  disabled={saving}
                  onChange={event => {
                    setGroup(event.target.value)
                    setDraftIcon(undefined)
                  }}
                />
                <datalist id="model-group-icon-groups">
                  {groupNames.map(name => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="model-group-icon-choice">{t('model_group_icons.icon')}</Label>
                <div className="flex items-center gap-3">
                  <select
                    id="model-group-icon-choice"
                    data-testid="model-group-icon-choice"
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-base px-3 text-sm"
                    value={icon}
                    disabled={saving || !groupName}
                    onChange={event => setDraftIcon(event.target.value)}
                  >
                    <option value="">{t('model_group_icons.automatic')}</option>
                    {Object.keys(modelPrimaryGroupIconChoices).map(choice => (
                      <option key={choice} value={choice}>
                        {t(`model_group_icons.choices.${choice}`)}
                      </option>
                    ))}
                  </select>
                  <ModelPrimaryGroupIcon group={groupName} icon={icon} decorative />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={saving || !groupName || icon === savedIcon}
                  data-testid="model-group-icon-save"
                >
                  {t('model_group_icons.save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
