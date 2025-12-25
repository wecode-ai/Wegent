// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { PackageIcon, SearchIcon, CheckIcon, ServerIcon, WrenchIcon } from 'lucide-react'
import LoadingState from '@/features/common/LoadingState'
import { getMarketTools, getToolCategories } from '@/apis/tools'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
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
import type { ToolMarketItem } from '@/types/tool'

interface ToolMarketDialogProps {
  open: boolean
  onClose: () => void
  onSelectTool: (tool: ToolMarketItem) => void
  selectedToolNames?: string[]
}

export default function ToolMarketDialog({
  open,
  onClose,
  onSelectTool,
  selectedToolNames = [],
}: ToolMarketDialogProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()
  const [tools, setTools] = useState<ToolMarketItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchText, setSearchText] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')

  const loadTools = useCallback(async () => {
    setIsLoading(true)
    try {
      const [toolsRes, categoriesRes] = await Promise.all([
        getMarketTools({
          category: selectedCategory === 'all' ? undefined : selectedCategory,
          search: searchText || undefined,
        }),
        getToolCategories(),
      ])
      setTools(toolsRes.items)
      setCategories(categoriesRes.categories)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('tools.failed_load'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t, selectedCategory, searchText])

  useEffect(() => {
    if (open) {
      loadTools()
    }
  }, [open, loadTools])

  const handleAddTool = (tool: ToolMarketItem) => {
    onSelectTool(tool)
  }

  const isToolSelected = (toolName: string) => {
    return selectedToolNames.includes(toolName)
  }

  const getToolIcon = (type: string) => {
    return type === 'mcp' ? (
      <ServerIcon className="h-4 w-4 text-primary" />
    ) : (
      <WrenchIcon className="h-4 w-4 text-primary" />
    )
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[800px] max-h-[80vh] flex flex-col bg-surface">
        <DialogHeader>
          <DialogTitle>{t('tools.select_tool')}</DialogTitle>
          <DialogDescription>{t('tools.select_tool_description')}</DialogDescription>
        </DialogHeader>

        {/* Search and Filter */}
        <div className="flex gap-3 py-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-secondary" />
            <Input
              placeholder={t('tools.search_placeholder')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t('tools.all_categories')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('tools.all_categories')}</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {t(`tools.category_${category}`, category)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Tool List */}
        <div className="flex-1 overflow-y-auto py-2">
          {isLoading ? (
            <LoadingState message={t('tools.loading')} />
          ) : tools.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-text-secondary">
              <PackageIcon className="h-10 w-10 mb-2 opacity-50" />
              <p>{t('tools.no_tools_found')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {tools.map((tool) => (
                <Card key={tool.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getToolIcon(tool.type)}
                        <h4 className="font-medium text-text-primary truncate">{tool.name}</h4>
                        {tool.category && (
                          <Tag variant="secondary" size="sm">
                            {t(`tools.category_${tool.category}`, tool.category)}
                          </Tag>
                        )}
                      </div>
                      {tool.description && (
                        <p className="text-sm text-text-secondary line-clamp-2">
                          {tool.description}
                        </p>
                      )}
                      {tool.tags && tool.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {tool.tags.map((tag) => (
                            <Tag key={tag} variant="outline" size="sm">
                              {tag}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {isToolSelected(tool.name) ? (
                        <Button variant="outline" size="sm" disabled>
                          <CheckIcon className="h-4 w-4 mr-1" />
                          {t('tools.added')}
                        </Button>
                      ) : (
                        <Button variant="default" size="sm" onClick={() => handleAddTool(tool)}>
                          {t('tools.add')}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
