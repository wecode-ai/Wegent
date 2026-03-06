// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Search,
  Download,
  Loader2,
  Package,
  Tag,
  User,
  Calendar,
  DownloadIcon,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { searchSkills, downloadSkill, MarketSkill } from '@/apis/skillMarket'
import { uploadSkill } from '@/apis/skills'

interface SkillSearchModalProps {
  open: boolean
  onClose: () => void
  onSkillsChange?: () => void
  namespace?: string
}

interface InstallingSkill {
  skillKey: string
  status: 'downloading' | 'installing' | 'success' | 'error'
  error?: string
}

export default function SkillSearchModal({
  open,
  onClose,
  onSkillsChange,
  namespace = 'default',
}: SkillSearchModalProps) {
  const { t } = useTranslation('common')
  const { toast } = useToast()

  // Search state
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [skills, setSkills] = useState<MarketSkill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [hasSearched, setHasSearched] = useState(false)

  // Installation state
  const [installingSkills, setInstallingSkills] = useState<Map<string, InstallingSkill>>(new Map())

  // Reset installation state when modal opens
  useEffect(() => {
    if (open) {
      setInstallingSkills(new Map())
    }
  }, [open])

  // Search skills
  const handleSearch = useCallback(
    async (searchPage = 1) => {
      setSearching(true)
      setHasSearched(true)

      try {
        const result = await searchSkills({
          keyword: keyword || undefined,
          page: searchPage,
          pageSize,
        })

        setSkills(result.skills)
        setTotal(result.total)
        setPage(result.page)
      } catch (error) {
        toast({
          variant: 'destructive',
          title: t('skills.search_failed'),
          description: error instanceof Error ? error.message : t('common:common.unknown_error'),
        })
      } finally {
        setSearching(false)
      }
    },
    [keyword, pageSize, toast, t]
  )

  // Handle page change
  const handlePageChange = (newPage: number) => {
    handleSearch(newPage)
  }

  // Install skill
  const handleInstallSkill = async (skill: MarketSkill) => {
    const existingStatus = installingSkills.get(skill.skillKey)
    // Allow retry if status is error, block if downloading/installing/success
    if (existingStatus && existingStatus.status !== 'error') return

    setInstallingSkills(prev => {
      const newMap = new Map(prev)
      newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'downloading' })
      return newMap
    })

    try {
      // Download skill from market
      const blob = await downloadSkill(skill.skillKey)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'installing' })
        return newMap
      })

      // Extract realSkillKey from skillKey format: {owner}_{parentSkill}_{realSkillKey}
      // parentSkill may not exist, so we take the content after the last underscore
      const lastUnderscoreIndex = skill.skillKey.lastIndexOf('_')
      const realSkillKey =
        lastUnderscoreIndex !== -1
          ? skill.skillKey.substring(lastUnderscoreIndex + 1)
          : skill.skillKey

      // Convert blob to file
      const file = new File([blob], `${realSkillKey}.zip`, { type: 'application/zip' })

      // Upload to local system
      await uploadSkill(file, realSkillKey, namespace)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'success' })
        return newMap
      })

      toast({
        title: t('skills.install_success'),
        description: t('skills.install_success_message', { skillName: skill.name }),
      })

      onSkillsChange?.()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, {
          skillKey: skill.skillKey,
          status: 'error',
          error: errorMessage,
        })
        return newMap
      })

      toast({
        variant: 'destructive',
        title: t('skills.install_failed'),
        description: errorMessage,
      })
    }
  }

  // Handle close
  const handleClose = () => {
    if (
      Array.from(installingSkills.values()).some(
        s => s.status === 'downloading' || s.status === 'installing'
      )
    ) {
      return
    }
    onClose()
  }

  // Handle key press in search input
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch(1)
    }
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / pageSize)

  // Get installation status for a skill
  const getInstallStatus = (skillKey: string): InstallingSkill | undefined => {
    return installingSkills.get(skillKey)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[900px] max-h-[85vh] flex flex-col bg-surface">
        <DialogHeader>
          <DialogTitle>{t('skills.search_skills_title')}</DialogTitle>
          <DialogDescription>{t('skills.search_skills_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 mt-4 flex-1 overflow-hidden">
          {/* Search Input */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
              <Input
                placeholder={t('skills.search_placeholder')}
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyPress={handleKeyPress}
                className="pl-9"
              />
            </div>
            <Button onClick={() => handleSearch(1)} disabled={searching}>
              {searching ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('actions.searching')}
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  {t('actions.search')}
                </>
              )}
            </Button>
          </div>

          {/* Results Area */}
          <div className="flex-1 overflow-y-auto min-h-[300px]">
            {!hasSearched ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted">
                <Package className="w-12 h-12 mb-4 opacity-50" />
                <p>{t('skills.search_hint')}</p>
              </div>
            ) : searching ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted">
                <Loader2 className="w-8 h-8 animate-spin mb-2" />
                <p>{t('skills.searching_skills')}</p>
              </div>
            ) : skills.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted">
                <Package className="w-12 h-12 mb-4 opacity-50" />
                <p>{t('skills.no_search_results')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {skills.map(skill => {
                  const installStatus = getInstallStatus(skill.skillKey)
                  const isInstalling =
                    installStatus?.status === 'downloading' ||
                    installStatus?.status === 'installing'
                  const isInstalled = installStatus?.status === 'success'
                  const isError = installStatus?.status === 'error'

                  return (
                    <Card key={skill.skillKey} className="p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between gap-4">
                        {/* Skill Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-medium text-text-primary">{skill.name}</h3>
                            {skill.version && (
                              <Badge variant="secondary" className="text-xs">
                                v{skill.version}
                              </Badge>
                            )}
                            {skill.visibility === 'public' ? (
                              <Badge variant="success" className="text-xs">
                                {t('skills.public_skill')}
                              </Badge>
                            ) : (
                              <Badge variant="default" className="text-xs">
                                {t('skills.private_skill')}
                              </Badge>
                            )}
                          </div>

                          <p className="text-sm text-text-secondary line-clamp-2 mb-2">
                            {skill.description}
                          </p>

                          {/* Meta Info */}
                          <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                            <span className="flex items-center gap-1">
                              <User className="w-3 h-3" />
                              {skill.author}
                            </span>
                            <span className="flex items-center gap-1">
                              <DownloadIcon className="w-3 h-3" />
                              {skill.downloadCount}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {new Date(skill.createdAt).toLocaleDateString()}
                            </span>
                          </div>

                          {/* Tags */}
                          {skill.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {skill.tags.map(tag => (
                                <Badge key={tag} variant="info" className="text-xs">
                                  <Tag className="w-3 h-3 mr-1" />
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Install Button */}
                        <div className="flex-shrink-0">
                          {isInstalled ? (
                            <Button variant="ghost" size="sm" disabled className="text-green-600">
                              <CheckCircle2 className="w-4 h-4 mr-1" />
                              {t('skills.installed')}
                            </Button>
                          ) : isError ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleInstallSkill(skill)}
                              disabled={isInstalling}
                              className="text-red-600"
                            >
                              <XCircle className="w-4 h-4 mr-1" />
                              {t('skills.retry_install')}
                            </Button>
                          ) : (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => handleInstallSkill(skill)}
                              disabled={isInstalling}
                            >
                              {isInstalling ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                                  {installStatus?.status === 'downloading'
                                    ? t('skills.downloading')
                                    : t('skills.installing')}
                                </>
                              ) : (
                                <>
                                  <Download className="w-4 h-4 mr-1" />
                                  {t('skills.install')}
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Error Message */}
                      {isError && installStatus?.error && (
                        <div className="mt-2 p-2 bg-red-50 text-red-600 text-xs rounded flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                          <span>{installStatus.error}</span>
                        </div>
                      )}
                    </Card>
                  )
                })}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm text-text-muted">
                {t('common:common.page_info', { current: page, total: totalPages })}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1 || searching}
                >
                  {t('common:common.previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages || searching}
                >
                  {t('common:common.next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
