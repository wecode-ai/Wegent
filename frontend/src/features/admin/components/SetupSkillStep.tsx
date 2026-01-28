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
import { Loader2, UploadIcon, FileIcon, AlertCircle, PlusIcon } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchPublicSkillsList,
  uploadPublicSkill,
  deletePublicSkill,
  UnifiedSkill,
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

  // Upload form states
  const [skillName, setSkillName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

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

  const handleCloseUploadDialog = () => {
    if (!uploading) {
      setIsUploadDialogOpen(false)
      resetUploadForm()
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-text-primary">
          {t('setup_wizard.skill_step.title')}
        </h3>
        <p className="text-sm text-text-muted mt-1">
          {t('setup_wizard.skill_step.description')}
        </p>
      </div>

      {/* Skill List */}
      <div className="bg-base border border-border rounded-md p-3 min-h-[200px] max-h-[300px] overflow-y-auto">
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

      {/* Upload Button */}
      <div className="flex justify-center">
        <Button
          variant="outline"
          onClick={() => {
            resetUploadForm()
            setIsUploadDialogOpen(true)
          }}
          className="gap-2"
        >
          <PlusIcon className="w-4 h-4" />
          {t('setup_wizard.skill_step.upload_skill')}
        </Button>
      </div>

      {/* Upload Skill Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={open => !open && handleCloseUploadDialog()}>
        <DialogContent className="sm:max-w-[500px] bg-surface">
          <DialogHeader>
            <DialogTitle>{t('setup_wizard.skill_step.upload_skill')}</DialogTitle>
            <DialogDescription>
              {t('setup_wizard.skill_step.file_requirements')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Skill Name Input */}
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
                onClick={() => !uploading && document.getElementById('skill-file-input')?.click()}
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
                  <li>Maximum file size: 10MB</li>
                </ul>
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseUploadDialog} disabled={uploading}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUploadSubmit} disabled={uploading || !selectedFile}>
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                t('setup_wizard.skill_step.upload_skill')
              )}
            </Button>
          </DialogFooter>
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
    </div>
  )
}

export default SetupSkillStep
