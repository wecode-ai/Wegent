// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { SkillCategory } from '@/types/api'
import type { UnifiedSkill } from '@/apis/skills'
import { publishToMarketplace } from '@/apis/skills'

interface PublishSkillDialogProps {
  open: boolean
  onClose: (published: boolean) => void
  skill: UnifiedSkill
  categories: SkillCategory[]
}

export default function PublishSkillDialog({
  open,
  onClose,
  skill,
  categories,
}: PublishSkillDialogProps) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const isEnglish = i18n.language === 'en'

  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [marketDescription, setMarketDescription] = useState<string>(
    skill.description || ''
  )
  const [readme, setReadme] = useState<string>('')
  const [isPublishing, setIsPublishing] = useState(false)

  const getCategoryDisplayName = (category: SkillCategory) => {
    return isEnglish ? category.displayNameEn : category.displayName
  }

  const handlePublish = async () => {
    if (!selectedCategory) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: t('common:skills.marketplace.category_required'),
      })
      return
    }

    setIsPublishing(true)
    try {
      await publishToMarketplace({
        skill_id: skill.id,
        category: selectedCategory,
        market_description: marketDescription || undefined,
        readme: readme || undefined,
      })
      toast({
        title: t('common:common.success'),
        description: t('common:skills.marketplace.publish_success'),
      })
      onClose(true)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description:
          error instanceof Error
            ? error.message
            : t('common:common.unknown_error'),
      })
    } finally {
      setIsPublishing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => !isPublishing && onClose(false)}>
      <DialogContent className="sm:max-w-[500px] bg-surface">
        <DialogHeader>
          <DialogTitle>{t('common:skills.marketplace.publish')}</DialogTitle>
          <DialogDescription>
            {t('common:skills.marketplace.publish_description', {
              skillName: skill.displayName || skill.name,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Category Selection */}
          <div className="space-y-2">
            <Label htmlFor="category">
              {t('common:skills.marketplace.category')}{' '}
              <span className="text-error">*</span>
            </Label>
            <Select
              value={selectedCategory}
              onValueChange={setSelectedCategory}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('common:skills.marketplace.select_category')}
                />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.name} value={category.name}>
                    {getCategoryDisplayName(category)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Market Description */}
          <div className="space-y-2">
            <Label htmlFor="marketDescription">
              {t('common:skills.marketplace.market_description')}
            </Label>
            <Textarea
              id="marketDescription"
              value={marketDescription}
              onChange={(e) => setMarketDescription(e.target.value)}
              placeholder={t(
                'common:skills.marketplace.market_description_placeholder'
              )}
              rows={3}
            />
          </div>

          {/* README */}
          <div className="space-y-2">
            <Label htmlFor="readme">
              {t('common:skills.marketplace.readme')}
            </Label>
            <Textarea
              id="readme"
              value={readme}
              onChange={(e) => setReadme(e.target.value)}
              placeholder={t('common:skills.marketplace.readme_placeholder')}
              rows={5}
              className="font-mono text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onClose(false)}
            disabled={isPublishing}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handlePublish}
            disabled={isPublishing || !selectedCategory}
          >
            {isPublishing ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('common:actions.publishing')}
              </div>
            ) : (
              t('common:skills.marketplace.publish')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
