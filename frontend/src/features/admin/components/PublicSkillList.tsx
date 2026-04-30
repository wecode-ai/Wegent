// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  SparklesIcon,
  PencilIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  EyeIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'
import { Loader2, UploadIcon, FileIcon, AlertCircle } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  fetchPublicSkillsList,
  uploadPublicSkill,
  updatePublicSkillWithUpload,
  updatePublicSkill,
  deletePublicSkill,
  downloadPublicSkill,
  getPublicSkillContent,
  UnifiedSkill,
} from '@/apis/skills'
import { Switch } from '@/components/ui/switch'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const PublicSkillList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isViewContentDialogOpen, setIsViewContentDialogOpen] = useState(false)
  const [isMetadataDialogOpen, setIsMetadataDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<UnifiedSkill | null>(null)
  const [skillContent, setSkillContent] = useState<string>('')
  const [loadingContent, setLoadingContent] = useState(false)

  // Upload form states
  const [skillName, setSkillName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [isEditMode, setIsEditMode] = useState(false)

  // Metadata edit form states
  const [metadataForm, setMetadataForm] = useState({
    description: '',
    version: '',
    author: '',
    tags: '',
    visible: true,
  })
  const [updatingMetadata, setUpdatingMetadata] = useState(false)

  const fetchSkills = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchPublicSkillsList({ limit: 100 })
      setSkills(data)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_skills.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

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
      if (!isEditMode && !skillName) {
        const nameFromFile = file.name.replace(/\.zip$/i, '')
        setSkillName(nameFromFile)
      }
    },
    [isEditMode, skillName]
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

  const handleUploadSubmit = async () => {
    if (!selectedFile) {
      setError('Please select a file')
      return
    }

    if (!isEditMode && !skillName.trim()) {
      setError('Please enter a skill name')
      return
    }

    setUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      if (isEditMode && selectedSkill) {
        await updatePublicSkillWithUpload(selectedSkill.id, selectedFile, setUploadProgress)
        toast({ title: t('admin:public_skills.success.updated') })
      } else {
        await uploadPublicSkill(selectedFile, skillName.trim(), setUploadProgress)
        toast({ title: t('admin:public_skills.success.uploaded') })
      }
      setIsUploadDialogOpen(false)
      resetUploadForm()
      fetchSkills()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Upload failed'
      setError(errorMessage)
      toast({
        variant: 'destructive',
        title: isEditMode
          ? t('admin:public_skills.errors.update_failed')
          : t('admin:public_skills.errors.upload_failed'),
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
      toast({ title: t('admin:public_skills.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedSkill(null)
      fetchSkills()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_skills.errors.delete_failed'),
        description: (error as Error).message,
      })
    }
  }

  const handleDownloadSkill = async (skill: UnifiedSkill) => {
    try {
      await downloadPublicSkill(skill.id, skill.name)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:public_skills.errors.download_failed'),
        description: (error as Error).message,
      })
    }
  }

  const handleViewContent = async (skill: UnifiedSkill) => {
    setSelectedSkill(skill)
    setLoadingContent(true)
    setSkillContent('')
    setIsViewContentDialogOpen(true)

    try {
      const result = await getPublicSkillContent(skill.id)
      setSkillContent(result.content)
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('admin:public_skills.errors.view_content_failed'),
        description: (err as Error).message,
      })
      setSkillContent('')
    } finally {
      setLoadingContent(false)
    }
  }

  const resetUploadForm = () => {
    setSkillName('')
    setSelectedFile(null)
    setUploadProgress(0)
    setError(null)
    setSelectedSkill(null)
    setIsEditMode(false)
  }

  const openUploadDialog = (skill?: UnifiedSkill) => {
    if (skill) {
      setSelectedSkill(skill)
      setSkillName(skill.name)
      setIsEditMode(true)
    } else {
      resetUploadForm()
    }
    setIsUploadDialogOpen(true)
  }

  const openMetadataDialog = (skill: UnifiedSkill) => {
    setSelectedSkill(skill)
    setMetadataForm({
      description: skill.description || '',
      version: skill.version || '',
      author: skill.author || '',
      tags: skill.tags?.join(', ') || '',
      visible: skill.visible !== false, // default to true if undefined
    })
    setIsMetadataDialogOpen(true)
  }

  const handleUpdateMetadata = async () => {
    if (!selectedSkill) return

    setUpdatingMetadata(true)
    try {
      await updatePublicSkill(selectedSkill.id, {
        description: metadataForm.description,
        version: metadataForm.version,
        author: metadataForm.author,
        tags: metadataForm.tags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean),
        visible: metadataForm.visible,
      })
      toast({ title: t('admin:public_skills.success.metadata_updated') })
      setIsMetadataDialogOpen(false)
      fetchSkills()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('admin:public_skills.errors.metadata_update_failed'),
        description: (err as Error).message,
      })
    } finally {
      setUpdatingMetadata(false)
    }
  }

  const handleCloseUploadDialog = () => {
    if (!uploading) {
      setIsUploadDialogOpen(false)
      resetUploadForm()
    }
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString()
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('admin:public_skills.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('admin:public_skills.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && skills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <SparklesIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:public_skills.no_skills')}</p>
          </div>
        )}

        {/* Skill List */}
        {!loading && skills.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {skills.map(skill => (
              <Card
                key={skill.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <SparklesIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0 flex-wrap gap-1">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {skill.displayName || skill.name}
                        </h3>
                        {skill.version && <Tag variant="info">v{skill.version}</Tag>}
                        {skill.visible === false && (
                          <Tag variant="warning">{t('admin:public_skills.hidden')}</Tag>
                        )}
                        {skill.tags?.map(tag => (
                          <Tag key={tag} variant="default">
                            {tag}
                          </Tag>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted flex-wrap">
                        {skill.description && (
                          <>
                            <span className="truncate max-w-[300px]">{skill.description}</span>
                            <span>•</span>
                          </>
                        )}
                        {skill.author && (
                          <>
                            <span>
                              {t('admin:public_skills.columns.author')}: {skill.author}
                            </span>
                            <span>•</span>
                          </>
                        )}
                        <span>
                          {t('admin:public_skills.columns.created_at')}:{' '}
                          {formatDate(skill.created_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleViewContent(skill)}
                      title={t('admin:public_skills.view_content')}
                    >
                      <EyeIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openMetadataDialog(skill)}
                      title={t('admin:public_skills.edit_metadata')}
                    >
                      <Cog6ToothIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openUploadDialog(skill)}
                      title={t('admin:public_skills.update_skill')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDownloadSkill(skill)}
                      title={t('admin:public_skills.download_skill')}
                    >
                      <ArrowDownTrayIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedSkill(skill)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('admin:public_skills.delete_skill')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => openUploadDialog()}>
                {t('admin:public_skills.upload_skill')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Upload/Update Skill Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={open => !open && handleCloseUploadDialog()}>
        <DialogContent className="sm:max-w-[500px] bg-surface">
          <DialogHeader>
            <DialogTitle>
              {isEditMode
                ? t('admin:public_skills.update_skill')
                : t('admin:public_skills.upload_skill')}
            </DialogTitle>
            <DialogDescription>
              {isEditMode
                ? `Update the ZIP package for skill "${selectedSkill?.displayName || selectedSkill?.name}"`
                : 'Upload a new public skill ZIP package'}
            </DialogDescription>
            <div className="mt-2 text-xs text-text-muted">
              <strong>Expected structure:</strong>
              <div className="font-mono bg-muted p-2 rounded mt-1">
                my-skill.zip
                <br />
                └── my-skill/
                <br />
                &nbsp;&nbsp;&nbsp;&nbsp;├── SKILL.md
                <br />
                &nbsp;&nbsp;&nbsp;&nbsp;└── resources/
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Skill Name Input (only for create mode) */}
            {!isEditMode && (
              <div className="space-y-2">
                <Label htmlFor="skill-name">Skill Name *</Label>
                <Input
                  id="skill-name"
                  placeholder="Enter skill name"
                  value={skillName}
                  onChange={e => setSkillName(e.target.value)}
                  disabled={uploading}
                />
                <p className="text-xs text-text-muted">
                  A unique name for this skill (e.g., mermaid-diagram)
                </p>
              </div>
            )}

            {/* File Upload Area */}
            <div className="space-y-2">
              <Label>ZIP Package *</Label>
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
                onClick={() => !uploading && document.getElementById('file-input')?.click()}
              >
                <input
                  id="file-input"
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
                      Drop your ZIP file here or click to browse
                    </p>
                    <p className="text-xs text-text-muted">Maximum file size: 10MB</p>
                  </div>
                )}
              </div>
            </div>

            {/* Upload Progress */}
            {uploading && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary">Uploading...</span>
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
                <strong>Requirements:</strong>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>File must be a ZIP archive</li>
                  <li>Must contain a folder with the skill name</li>
                  <li>Must include SKILL.md with metadata</li>
                  <li>Optional: resources/ folder for additional files</li>
                  <li>Maximum file size: 10MB</li>
                </ul>
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseUploadDialog} disabled={uploading}>
              {t('admin:common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleUploadSubmit}
              disabled={uploading || !selectedFile}
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : isEditMode ? (
                t('admin:public_skills.update_skill')
              ) : (
                t('admin:public_skills.upload_skill')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:public_skills.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:public_skills.confirm.delete_message', { name: selectedSkill?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin:common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSkill} className="bg-error hover:bg-error/90">
              {t('admin:common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View Content Dialog */}
      <Dialog open={isViewContentDialogOpen} onOpenChange={setIsViewContentDialogOpen}>
        <DialogContent className="sm:max-w-[700px] max-h-[80vh] bg-surface">
          <DialogHeader>
            <DialogTitle>
              {selectedSkill?.displayName || selectedSkill?.name} -{' '}
              {t('admin:public_skills.skill_content')}
            </DialogTitle>
            <DialogDescription>
              {t('admin:public_skills.view_content_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {loadingContent ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
              </div>
            ) : skillContent ? (
              <div className="max-h-[50vh] overflow-y-auto">
                <pre className="text-sm text-text-primary bg-muted p-4 rounded-md whitespace-pre-wrap break-words font-mono">
                  {skillContent}
                </pre>
              </div>
            ) : (
              <div className="text-center py-8 text-text-muted">
                {t('admin:public_skills.no_content')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewContentDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Metadata Dialog */}
      <Dialog open={isMetadataDialogOpen} onOpenChange={setIsMetadataDialogOpen}>
        <DialogContent className="sm:max-w-[500px] bg-surface">
          <DialogHeader>
            <DialogTitle>{t('admin:public_skills.edit_metadata_title')}</DialogTitle>
            <DialogDescription>
              {t('admin:public_skills.edit_metadata_description', {
                name: selectedSkill?.displayName || selectedSkill?.name,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="skill-description">
                {t('admin:public_skills.fields.description')}
              </Label>
              <Input
                id="skill-description"
                placeholder={t('admin:public_skills.placeholders.description')}
                value={metadataForm.description}
                onChange={e => setMetadataForm({ ...metadataForm, description: e.target.value })}
                disabled={updatingMetadata}
              />
            </div>

            {/* Version */}
            <div className="space-y-2">
              <Label htmlFor="skill-version">{t('admin:public_skills.fields.version')}</Label>
              <Input
                id="skill-version"
                placeholder={t('admin:public_skills.placeholders.version')}
                value={metadataForm.version}
                onChange={e => setMetadataForm({ ...metadataForm, version: e.target.value })}
                disabled={updatingMetadata}
              />
            </div>

            {/* Author */}
            <div className="space-y-2">
              <Label htmlFor="skill-author">{t('admin:public_skills.fields.author')}</Label>
              <Input
                id="skill-author"
                placeholder={t('admin:public_skills.placeholders.author')}
                value={metadataForm.author}
                onChange={e => setMetadataForm({ ...metadataForm, author: e.target.value })}
                disabled={updatingMetadata}
              />
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <Label htmlFor="skill-tags">{t('admin:public_skills.fields.tags')}</Label>
              <Input
                id="skill-tags"
                placeholder={t('admin:public_skills.placeholders.tags')}
                value={metadataForm.tags}
                onChange={e => setMetadataForm({ ...metadataForm, tags: e.target.value })}
                disabled={updatingMetadata}
              />
              <p className="text-xs text-text-muted">{t('admin:public_skills.hints.tags')}</p>
            </div>

            {/* Visible Toggle */}
            <div className="flex items-center justify-between space-y-0 rounded-lg border border-border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="skill-visible" className="text-base">
                  {t('admin:public_skills.fields.visible')}
                </Label>
                <p className="text-xs text-text-muted">{t('admin:public_skills.hints.visible')}</p>
              </div>
              <Switch
                id="skill-visible"
                checked={metadataForm.visible}
                onCheckedChange={checked => setMetadataForm({ ...metadataForm, visible: checked })}
                disabled={updatingMetadata}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsMetadataDialogOpen(false)}
              disabled={updatingMetadata}
            >
              {t('admin:common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleUpdateMetadata} disabled={updatingMetadata}>
              {updatingMetadata ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('admin:common.saving')}
                </>
              ) : (
                t('admin:common.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default PublicSkillList
