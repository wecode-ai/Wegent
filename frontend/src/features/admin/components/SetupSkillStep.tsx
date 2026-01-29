// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { SparklesIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  Loader2,
  UploadIcon,
  FileIcon,
  AlertCircle,
  PlusIcon,
  GitBranch,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchPublicSkillsList,
  uploadPublicSkill,
  deletePublicSkill,
  UnifiedSkill,
  scanGitRepoPublicSkills,
  importGitRepoPublicSkills,
  GitSkillInfo,
  GitImportResponse,
} from '@/apis/skills'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const SetupSkillStep: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()

  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<UnifiedSkill | null>(null)

  // Tab state
  const [activeTab, setActiveTab] = useState<'upload' | 'git'>('upload')

  // Upload form states
  const [skillName, setSkillName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  // Git import states
  const [gitUrl, setGitUrl] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scannedSkills, setScannedSkills] = useState<GitSkillInfo[]>([])
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [conflictingSkills, setConflictingSkills] = useState<string[]>([])
  const [selectedOverwrites, setSelectedOverwrites] = useState<Set<string>>(new Set())
  const [importResult, setImportResult] = useState<GitImportResponse | null>(null)
  const [showResult, setShowResult] = useState(false)

  // Fetch existing public skills
  const fetchSkills = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchPublicSkillsList({ limit: 100 })
      setSkills(data)
    } catch (error) {
      console.error('Failed to fetch skills:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  // ============================================================================
  // Upload Tab Logic
  // ============================================================================

  const validateFile = (file: File): string | null => {
    if (!file.name.endsWith('.zip')) {
      return 'File must be a ZIP archive'
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File size exceeds 10MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB)`
    }
    return null
  }

  const handleFileSelect = useCallback(
    (file: File) => {
      const validationError = validateFile(file)
      if (validationError) {
        setError(validationError)
        setSelectedFile(null)
        return
      }

      setSelectedFile(file)
      setError(null)

      // Auto-fill skill name from filename (without .zip extension)
      if (!skillName) {
        const nameFromFile = file.name.replace(/\.zip$/i, '')
        setSkillName(nameFromFile)
      }
    },
    [skillName]
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileSelect(file)
    }
  }

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)

      const file = e.dataTransfer.files?.[0]
      if (file) {
        handleFileSelect(file)
      }
    },
    [handleFileSelect]
  )

  const resetUploadForm = () => {
    setSkillName('')
    setSelectedFile(null)
    setUploadProgress(0)
    setError(null)
  }

  const handleUploadSubmit = async () => {
    if (!selectedFile) {
      setError('Please select a file')
      return
    }

    if (!skillName.trim()) {
      setError('Please enter a skill name')
      return
    }

    setUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      await uploadPublicSkill(selectedFile, skillName.trim(), setUploadProgress)
      toast({ title: t('setup_wizard.skill_step.skill_uploaded') })
      setIsUploadDialogOpen(false)
      resetUploadForm()
      fetchSkills()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Upload failed'
      setError(errorMessage)
      toast({
        variant: 'destructive',
        title: t('public_skills.errors.upload_failed'),
        description: errorMessage,
      })
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteSkill = async () => {
    if (!selectedSkill) return

    try {
      await deletePublicSkill(selectedSkill.id)
      toast({ title: t('setup_wizard.skill_step.skill_deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedSkill(null)
      fetchSkills()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_skills.errors.delete_failed'),
        description: (error as Error).message,
      })
    }
  }

  // ============================================================================
  // Git Import Tab Logic
  // ============================================================================

  const validateGitUrl = (url: string): boolean => {
    if (!url.trim()) return false
    // Basic URL validation - should contain at least host/owner/repo pattern
    const urlPattern = /^(https?:\/\/)?[\w.-]+\/[\w.-]+\/[\w.-]+/i
    return urlPattern.test(url.trim())
  }

  const handleScanRepository = async () => {
    if (!validateGitUrl(gitUrl)) {
      setGitError(t('setup_wizard.skill_step.git_invalid_url'))
      return
    }

    setScanning(true)
    setGitError(null)
    setScannedSkills([])
    setSelectedSkillPaths(new Set())

    try {
      const result = await scanGitRepoPublicSkills(gitUrl.trim())
      setScannedSkills(result.skills)

      if (result.skills.length === 0) {
        setGitError(t('setup_wizard.skill_step.git_no_skills_found'))
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('setup_wizard.skill_step.git_download_failed')
      if (message.includes('not found') || message.includes('404')) {
        setGitError(t('setup_wizard.skill_step.git_repo_not_found'))
      } else {
        setGitError(message)
      }
    } finally {
      setScanning(false)
    }
  }

  const handleSelectAll = () => {
    if (selectedSkillPaths.size === scannedSkills.length) {
      setSelectedSkillPaths(new Set())
    } else {
      setSelectedSkillPaths(new Set(scannedSkills.map(s => s.path)))
    }
  }

  const handleToggleSkill = (path: string) => {
    const newSelected = new Set(selectedSkillPaths)
    if (newSelected.has(path)) {
      newSelected.delete(path)
    } else {
      newSelected.add(path)
    }
    setSelectedSkillPaths(newSelected)
  }

  const handleImportSkills = async () => {
    if (selectedSkillPaths.size === 0) return

    setImporting(true)
    setGitError(null)

    try {
      const request = {
        repo_url: gitUrl.trim(),
        skill_paths: Array.from(selectedSkillPaths),
      }

      const result = await importGitRepoPublicSkills(request)

      // Check if there are skipped skills (conflicts)
      if (result.skipped.length > 0 && result.success.length === 0 && result.failed.length === 0) {
        // All selected skills have conflicts, show conflict dialog
        setConflictingSkills(result.skipped.map(s => s.name))
        setSelectedOverwrites(new Set())
        setConflictDialogOpen(true)
      } else {
        // Show result
        setImportResult(result)
        setShowResult(true)
      }
    } catch (err) {
      setGitError(
        err instanceof Error ? err.message : t('setup_wizard.skill_step.git_download_failed')
      )
    } finally {
      setImporting(false)
    }
  }

  const handleConflictConfirm = async () => {
    setConflictDialogOpen(false)
    setImporting(true)

    try {
      const request = {
        repo_url: gitUrl.trim(),
        skill_paths: Array.from(selectedSkillPaths),
        overwrite_names: Array.from(selectedOverwrites),
      }

      const result = await importGitRepoPublicSkills(request)
      setImportResult(result)
      setShowResult(true)
    } catch (err) {
      setGitError(
        err instanceof Error ? err.message : t('setup_wizard.skill_step.git_download_failed')
      )
    } finally {
      setImporting(false)
    }
  }

  const handleConflictCancel = () => {
    setConflictDialogOpen(false)
    setConflictingSkills([])
    setSelectedOverwrites(new Set())
  }

  const handleToggleOverwrite = (name: string) => {
    const newSelected = new Set(selectedOverwrites)
    if (newSelected.has(name)) {
      newSelected.delete(name)
    } else {
      newSelected.add(name)
    }
    setSelectedOverwrites(newSelected)
  }

  const handleResultDone = () => {
    setShowResult(false)
    setImportResult(null)
    if (importResult && importResult.total_success > 0) {
      setIsUploadDialogOpen(false)
      resetGitState()
      fetchSkills()
    }
  }

  const resetGitState = () => {
    setGitUrl('')
    setScannedSkills([])
    setSelectedSkillPaths(new Set())
    setGitError(null)
    setImportResult(null)
    setShowResult(false)
  }

  const handleCloseUploadDialog = () => {
    if (!uploading && !scanning && !importing) {
      setIsUploadDialogOpen(false)
      resetUploadForm()
      resetGitState()
      setActiveTab('upload')
    }
  }

  const isLoading = scanning || importing

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-text-primary">
          {t('setup_wizard.skill_step.title')}
        </h3>
        <p className="text-sm text-text-muted mt-1">{t('setup_wizard.skill_step.description')}</p>
      </div>

      {/* Skill List */}
      <div className="bg-base border border-border rounded-md p-3 min-h-[200px]">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <SparklesIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('setup_wizard.skill_step.no_skills')}</p>
            <p className="text-xs text-text-muted mt-1">
              {t('setup_wizard.skill_step.file_requirements')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {skills.map(skill => (
              <Card
                key={skill.id}
                className="p-3 bg-surface hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <SparklesIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-text-primary truncate">
                          {skill.displayName || skill.name}
                        </span>
                        {skill.version && (
                          <Tag variant="info" className="text-xs">
                            v{skill.version}
                          </Tag>
                        )}
                        {skill.tags?.slice(0, 2).map(tag => (
                          <Tag key={tag} variant="default" className="text-xs">
                            {tag}
                          </Tag>
                        ))}
                        {skill.source?.type === 'git' && (
                          <Tag variant="default" className="text-xs">
                            <GitBranch className="w-3 h-3 mr-1" />
                            Git
                          </Tag>
                        )}
                      </div>
                      {skill.description && (
                        <div className="text-xs text-text-muted mt-0.5 truncate max-w-[400px]">
                          {skill.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:text-error"
                      onClick={() => {
                        setSelectedSkill(skill)
                        setIsDeleteDialogOpen(true)
                      }}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add Skill Button */}
      <div className="flex justify-center">
        <Button
          variant="outline"
          onClick={() => {
            resetUploadForm()
            resetGitState()
            setActiveTab('upload')
            setIsUploadDialogOpen(true)
          }}
          className="gap-2"
        >
          <PlusIcon className="w-4 h-4" />
          {t('setup_wizard.skill_step.add_skill')}
        </Button>
      </div>

      {/* Upload/Import Skill Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={open => !open && handleCloseUploadDialog()}>
        <DialogContent className="sm:max-w-[600px] bg-surface max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('setup_wizard.skill_step.add_skill')}</DialogTitle>
            <DialogDescription>
              {t('setup_wizard.skill_step.add_skill_description')}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'upload' | 'git')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload" className="flex items-center gap-2">
                <UploadIcon className="w-4 h-4" />
                {t('setup_wizard.skill_step.upload_tab')}
              </TabsTrigger>
              <TabsTrigger value="git" className="flex items-center gap-2" onClick={resetGitState}>
                <GitBranch className="w-4 h-4" />
                {t('setup_wizard.skill_step.git_import_tab')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="mt-4">
              <div className="space-y-4">
                {/* Skill Name Input */}
                <div className="space-y-2">
                  <Label htmlFor="skill-name">{t('setup_wizard.skill_step.skill_name')} *</Label>
                  <Input
                    id="skill-name"
                    placeholder={t('setup_wizard.skill_step.skill_name_placeholder')}
                    value={skillName}
                    onChange={e => setSkillName(e.target.value)}
                    disabled={uploading}
                  />
                  <p className="text-xs text-text-muted">
                    {t('setup_wizard.skill_step.skill_name_hint')}
                  </p>
                </div>

                {/* File Upload Area */}
                <div className="space-y-2">
                  <Label>{t('setup_wizard.skill_step.zip_package')} *</Label>
                  <div
                    className={`
                      relative border-2 border-dashed rounded-lg p-6 text-center transition-colors
                      ${dragActive ? 'border-primary bg-primary/5' : 'border-border'}
                      ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-primary/50'}
                    `}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                    onClick={() =>
                      !uploading && document.getElementById('skill-file-input')?.click()
                    }
                  >
                    <input
                      id="skill-file-input"
                      type="file"
                      accept=".zip"
                      onChange={handleFileChange}
                      className="hidden"
                      disabled={uploading}
                    />

                    {selectedFile ? (
                      <div className="flex items-center justify-center gap-2">
                        <FileIcon className="w-5 h-5 text-primary" />
                        <span className="text-sm text-text-primary">{selectedFile.name}</span>
                        <span className="text-xs text-text-muted">
                          ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                        </span>
                      </div>
                    ) : (
                      <div>
                        <UploadIcon className="w-8 h-8 mx-auto text-text-muted mb-2" />
                        <p className="text-sm text-text-primary mb-1">
                          {t('setup_wizard.skill_step.drag_drop_hint')}
                        </p>
                        <p className="text-xs text-text-muted">
                          {t('setup_wizard.skill_step.max_file_size')}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Upload Progress */}
                {uploading && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-text-secondary">
                        {t('setup_wizard.skill_step.uploading')}
                      </span>
                      <span className="text-text-secondary">{uploadProgress}%</span>
                    </div>
                    <Progress value={uploadProgress} />
                  </div>
                )}

                {/* Error Message */}
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {/* Requirements Info */}
                <Alert>
                  <AlertDescription className="text-xs">
                    <strong>{t('setup_wizard.skill_step.requirements')}:</strong>
                    <ul className="list-disc list-inside mt-1 space-y-0.5">
                      <li>{t('setup_wizard.skill_step.requirement_zip')}</li>
                      <li>{t('setup_wizard.skill_step.requirement_folder')}</li>
                      <li>{t('setup_wizard.skill_step.requirement_skill_md')}</li>
                      <li>{t('setup_wizard.skill_step.requirement_size')}</li>
                    </ul>
                  </AlertDescription>
                </Alert>

                <DialogFooter>
                  <Button variant="outline" onClick={handleCloseUploadDialog} disabled={uploading}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleUploadSubmit}
                    disabled={uploading || !selectedFile}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('setup_wizard.skill_step.uploading')}
                      </>
                    ) : (
                      t('setup_wizard.skill_step.upload_skill')
                    )}
                  </Button>
                </DialogFooter>
              </div>
            </TabsContent>

            <TabsContent value="git" className="mt-4">
              {showResult && importResult ? (
                <ImportResultView result={importResult} onDone={handleResultDone} t={t} />
              ) : (
                <div className="space-y-4">
                  {/* Git URL Input */}
                  <div className="space-y-2">
                    <Label htmlFor="git-url">{t('setup_wizard.skill_step.git_url_label')}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="git-url"
                        placeholder={t('setup_wizard.skill_step.git_url_placeholder')}
                        value={gitUrl}
                        onChange={e => setGitUrl(e.target.value)}
                        disabled={isLoading}
                        onKeyDown={e => e.key === 'Enter' && !isLoading && handleScanRepository()}
                      />
                      <Button
                        onClick={handleScanRepository}
                        disabled={isLoading || !gitUrl.trim()}
                        className="shrink-0"
                      >
                        {scanning ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            {t('setup_wizard.skill_step.git_scanning')}
                          </>
                        ) : (
                          <>
                            <Search className="w-4 h-4 mr-2" />
                            {t('setup_wizard.skill_step.git_scan_button')}
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-text-muted">
                      {t('setup_wizard.skill_step.git_url_hint')}
                    </p>
                  </div>

                  {/* Error Message */}
                  {gitError && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        {gitError}
                        {gitError === t('setup_wizard.skill_step.git_no_skills_found') && (
                          <p className="mt-1 text-xs opacity-80">
                            {t('setup_wizard.skill_step.git_no_skills_hint')}
                          </p>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Scanned Skills List */}
                  {scannedSkills.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {t('setup_wizard.skill_step.git_skills_found', {
                            count: scannedSkills.length,
                          })}
                        </span>
                        <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                          {selectedSkillPaths.size === scannedSkills.length
                            ? t('setup_wizard.skill_step.git_deselect_all')
                            : t('setup_wizard.skill_step.git_select_all')}
                        </Button>
                      </div>

                      <div className="max-h-60 overflow-y-auto border rounded-lg">
                        {scannedSkills.map(skill => (
                          <div
                            key={skill.path}
                            className="flex items-start space-x-3 p-3 border-b last:border-b-0 hover:bg-muted/50"
                          >
                            <Checkbox
                              id={`skill-${skill.path}`}
                              checked={selectedSkillPaths.has(skill.path)}
                              onCheckedChange={() => handleToggleSkill(skill.path)}
                              disabled={isLoading}
                              className="mt-0.5"
                            />
                            <label
                              htmlFor={`skill-${skill.path}`}
                              className="flex-1 cursor-pointer"
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm">{skill.name}</span>
                                {skill.version && (
                                  <span className="text-xs text-text-muted bg-muted px-1.5 py-0.5 rounded">
                                    v{skill.version}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-text-muted mt-0.5 line-clamp-2">
                                {skill.description}
                              </p>
                              <p className="text-xs text-text-muted/70 mt-0.5">{skill.path}</p>
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={handleCloseUploadDialog}
                      disabled={isLoading}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleImportSkills}
                      disabled={isLoading || selectedSkillPaths.size === 0}
                    >
                      {importing ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          {t('common.loading')}
                        </>
                      ) : (
                        t('setup_wizard.skill_step.git_import_selected')
                      )}
                    </Button>
                  </DialogFooter>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('public_skills.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('public_skills.confirm.delete_message', { name: selectedSkill?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSkill} className="bg-error hover:bg-error/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conflict Dialog (Git Import) */}
      <AlertDialog open={conflictDialogOpen} onOpenChange={setConflictDialogOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              {t('setup_wizard.skill_step.git_conflict_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('setup_wizard.skill_step.git_conflict_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-60 overflow-y-auto py-4">
            <div className="space-y-2">
              {conflictingSkills.map(name => (
                <div key={name} className="flex items-center space-x-2 p-2 rounded hover:bg-muted">
                  <Checkbox
                    id={`conflict-${name}`}
                    checked={selectedOverwrites.has(name)}
                    onCheckedChange={() => handleToggleOverwrite(name)}
                  />
                  <label
                    htmlFor={`conflict-${name}`}
                    className="text-sm font-medium cursor-pointer flex-1"
                  >
                    {name}
                  </label>
                </div>
              ))}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleConflictCancel}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConflictConfirm}>
              {t('setup_wizard.skill_step.git_import_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================================================
// Import Result View Component
// ============================================================================

interface ImportResultViewProps {
  result: GitImportResponse
  onDone: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function ImportResultView({ result, onDone, t }: ImportResultViewProps) {
  const [showFailedDetails, setShowFailedDetails] = useState(false)

  return (
    <div className="space-y-4">
      <div className="text-center py-4">
        <CheckCircle2 className="w-12 h-12 mx-auto text-green-500 mb-3" />
        <h3 className="text-lg font-semibold">
          {t('setup_wizard.skill_step.git_import_result_title')}
        </h3>
      </div>

      <div className="space-y-2">
        {result.total_success > 0 && (
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {t('setup_wizard.skill_step.git_import_success', { count: result.total_success })}
            </span>
          </div>
        )}
        {result.total_skipped > 0 && (
          <div className="flex items-center gap-2 text-yellow-600">
            <AlertTriangle className="w-4 h-4" />
            <span>
              {t('setup_wizard.skill_step.git_import_skipped', { count: result.total_skipped })}
            </span>
          </div>
        )}
        {result.total_failed > 0 && (
          <div className="space-y-1">
            <div
              className="flex items-center gap-2 text-red-600 cursor-pointer"
              onClick={() => setShowFailedDetails(!showFailedDetails)}
            >
              <XCircle className="w-4 h-4" />
              <span>
                {t('setup_wizard.skill_step.git_import_failed', { count: result.total_failed })}
              </span>
            </div>
            {showFailedDetails && (
              <div className="ml-6 mt-2 space-y-1 text-sm text-text-muted">
                <p className="font-medium text-text-secondary">
                  {t('setup_wizard.skill_step.git_import_failed_details')}:
                </p>
                {result.failed.map(item => (
                  <div key={item.path} className="pl-2 border-l-2 border-red-200">
                    <span className="font-medium">{item.name}</span>: {item.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="primary" onClick={onDone}>
          {t('common.done')}
        </Button>
      </DialogFooter>
    </div>
  )
}

export default SetupSkillStep
