// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  SearchIcon,
  ServerIcon,
  PackageIcon,
  WrenchIcon,
  PlusIcon,
  CheckIcon,
  Loader2Icon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { MarketSkill, SkillType } from '@/types/skill'
import {
  listMarketSkills,
  getSkillCategories,
  addSkillToGhost,
} from '@/apis/skills'
import LoadingState from '@/features/common/LoadingState'

interface SkillMarketDialogProps {
  open: boolean
  onClose: (added: boolean) => void
  ghostId: number
  existingSkillNames: string[]
}

export default function SkillMarketDialog({
  open,
  onClose,
  ghostId,
  existingSkillNames,
}: SkillMarketDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [skills, setSkills] = useState<MarketSkill[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedType, setSelectedType] = useState<string>('all')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [addingSkill, setAddingSkill] = useState<string | null>(null)
  const [addedSkills, setAddedSkills] = useState<Set<string>>(new Set())

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    try {
      const [skillsResponse, categoriesData] = await Promise.all([
        listMarketSkills({
          skillType: selectedType !== 'all' ? (selectedType as SkillType) : undefined,
          category: selectedCategory !== 'all' ? selectedCategory : undefined,
          search: searchTerm || undefined,
          visibility: 'public',
          pageSize: 50,
        }),
        getSkillCategories(),
      ])
      setSkills(skillsResponse.items)
      setCategories(categoriesData)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_load'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [selectedType, selectedCategory, searchTerm, toast, t])

  useEffect(() => {
    if (open) {
      loadSkills()
      setAddedSkills(new Set())
    }
  }, [open, loadSkills])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (open) {
        loadSkills()
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm, selectedType, selectedCategory])

  const handleAddSkill = async (skill: MarketSkill) => {
    setAddingSkill(skill.name)
    try {
      await addSkillToGhost(ghostId, skill.name)
      setAddedSkills(prev => new Set(prev).add(skill.name))
      toast({
        title: t('common.success'),
        description: t('tools.tool_added', { toolName: skill.name }),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_add'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setAddingSkill(null)
    }
  }

  const getSkillTypeIcon = (skillType: SkillType) => {
    switch (skillType) {
      case 'mcp':
        return <ServerIcon className="w-4 h-4" />
      case 'builtin':
        return <WrenchIcon className="w-4 h-4" />
      case 'skill':
      default:
        return <PackageIcon className="w-4 h-4" />
    }
  }

  const getSkillTypeText = (skillType: SkillType) => {
    switch (skillType) {
      case 'mcp':
        return t('tools.type_mcp')
      case 'builtin':
        return t('tools.type_builtin')
      case 'skill':
      default:
        return t('tools.type_skill')
    }
  }

  const isSkillAdded = (skillName: string) => {
    return existingSkillNames.includes(skillName) || addedSkills.has(skillName)
  }

  const handleClose = () => {
    onClose(addedSkills.size > 0)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[700px] max-h-[80vh] flex flex-col bg-surface">
        <DialogHeader>
          <DialogTitle>{t('tools.select_tool')}</DialogTitle>
          <DialogDescription>{t('tools.select_tool_description')}</DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 py-2">
          {/* Search */}
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <Input
              placeholder={t('tools.search_placeholder')}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Type Filter */}
          <Select value={selectedType} onValueChange={setSelectedType}>
            <SelectTrigger className="w-full sm:w-[140px]">
              <SelectValue placeholder={t('tools.all_types')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('tools.all_types')}</SelectItem>
              <SelectItem value="mcp">{t('tools.type_mcp')}</SelectItem>
              <SelectItem value="skill">{t('tools.type_skill')}</SelectItem>
              <SelectItem value="builtin">{t('tools.type_builtin')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Category Filter */}
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder={t('tools.all_categories')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('tools.all_categories')}</SelectItem>
              {categories.map(cat => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Skills List */}
        <div className="flex-1 overflow-y-auto py-2 min-h-[300px]">
          {isLoading ? (
            <LoadingState message={t('tools.loading')} />
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <ServerIcon className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-sm">{t('tools.no_tools_found')}</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {skills.map(skill => {
                const isAdded = isSkillAdded(skill.name)
                const isAdding = addingSkill === skill.name

                return (
                  <Card
                    key={skill.id}
                    className={`p-4 transition-all ${isAdded ? 'bg-success/5 border-success/30' : 'hover:shadow-sm'}`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Icon */}
                      <div className="flex-shrink-0 p-2 bg-surface-elevated rounded-md">
                        {getSkillTypeIcon(skill.skillType)}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-medium text-text-primary">
                            {skill.name}
                          </h4>
                          {isAdded && (
                            <CheckIcon className="w-4 h-4 text-success" />
                          )}
                        </div>
                        <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">
                          {skill.description}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <Tag variant="default" className="text-xs">
                            {getSkillTypeText(skill.skillType)}
                          </Tag>
                          {skill.category && (
                            <Tag variant="info" className="text-xs">
                              {skill.category}
                            </Tag>
                          )}
                          {skill.version && (
                            <Tag variant="default" className="text-xs">
                              v{skill.version}
                            </Tag>
                          )}
                          {skill.author && (
                            <span className="text-xs text-text-muted">
                              {t('tools.by_author', { author: skill.author })}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Add Button */}
                      <Button
                        variant={isAdded ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => handleAddSkill(skill)}
                        disabled={isAdded || isAdding}
                        className="flex-shrink-0"
                      >
                        {isAdding ? (
                          <Loader2Icon className="w-4 h-4 animate-spin" />
                        ) : isAdded ? (
                          <>
                            <CheckIcon className="w-4 h-4 mr-1" />
                            {t('tools.added')}
                          </>
                        ) : (
                          <>
                            <PlusIcon className="w-4 h-4 mr-1" />
                            {t('tools.add')}
                          </>
                        )}
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t">
          <Button variant="outline" onClick={handleClose}>
            {t('actions.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
