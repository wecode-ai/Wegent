// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { Skill } from '@/types/api'
import {
  uploadSkill,
  updateSkill,
  fetchSkillByName,
  UnifiedSkill,
  scanGitRepoSkills,
  importGitRepoSkills,
  scanGitRepoPublicSkills,
  importGitRepoPublicSkills,
  GitSkillInfo,
  GitImportResponse,
} from '@/apis/skills'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import {
  UploadIcon,
  FileIcon,
  AlertCircle,
  GitBranch,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface SkillUploadModalProps {
  open: boolean
  onClose: (saved: boolean) => void
  skill?: Skill | UnifiedSkill | null
  namespace?: string // Namespace for the skill (default: 'default', group name for group skills)
  isPublic?: boolean // Whether this is for public skill management (admin)
}

// Helper to get skill name from either type
function getSkillName(skill: Skill | UnifiedSkill | null | undefined): string {
  if (!skill) return ''
  if ('metadata' in skill) {
    return skill.metadata.name || ''
  }
  return skill.name || ''
}

// Helper to get skill id from either type
function getSkillId(skill: Skill | UnifiedSkill | null | undefined): number {
  if (!skill) return 0
  if ('metadata' in skill) {
    return parseInt(skill.metadata.labels?.id || '0')
  }
  return skill.id || 0
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export default function SkillUploadModal({
  open,
  onClose,
  skill,
  namespace: propNamespace,
  isPublic = false,
}: SkillUploadModalProps) {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<'upload' | 'git'>('upload')

  // Upload tab state
  const [skillName, setSkillName] = useState(getSkillName(skill))
  const namespace = propNamespace || 'default'
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false)
  const [existingSkill, setExistingSkill] = useState<Skill | null>(null)

  // Git import tab state
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

  const isEditMode = !!skill

  // ============================================================================
  // Upload Tab Logic
  // ============================================================================

  const validateFile = (file: File): string | null => {
    if (!file.name.endsWith('.zip')) {
      return t('skills.error_file_format')
    }
    if (file.size > MAX_FILE_SIZE) {
      return t('skills.error_file_size', {
        fileSize: (file.size / (1024 * 1024)).toFixed(1),
      })
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
    [isEditMode, skillName, t]
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

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError(t('skills.error_select_file'))
      return
    }

    if (!isEditMode && !skillName.trim()) {
      setError(t('skills.error_enter_name'))
      return
    }

    // Check if skill with same name already exists (only for create mode)
    if (!isEditMode) {
      try {
        const existing = await fetchSkillByName(skillName.trim(), namespace)
        if (existing) {
          setExistingSkill(existing)
          setOverwriteDialogOpen(true)
          return
        }
      } catch {
        // Ignore errors when checking for existing skill
      }
    }

    await performUpload()
  }

  const performUpload = async (overwrite: boolean = false) => {
    if (!selectedFile) return

    setUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      if (isEditMode && skill) {
        const skillId = getSkillId(skill)
        await updateSkill(skillId, selectedFile, setUploadProgress)
      } else if (overwrite && existingSkill) {
        // Update existing skill
        const skillId = parseInt(existingSkill.metadata.labels?.id || '0')
        await updateSkill(skillId, selectedFile, setUploadProgress)
      } else {
        await uploadSkill(selectedFile, skillName.trim(), namespace, setUploadProgress)
      }
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.error_upload_failed'))
    } finally {
      setUploading(false)
    }
  }

  const handleOverwriteConfirm = async () => {
    setOverwriteDialogOpen(false)
    await performUpload(true)
  }

  const handleOverwriteCancel = () => {
    setOverwriteDialogOpen(false)
    setExistingSkill(null)
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
      setGitError(t('skills.git_invalid_url'))
      return
    }

    setScanning(true)
    setGitError(null)
    setScannedSkills([])
    setSelectedSkillPaths(new Set())

    try {
      const scanFn = isPublic ? scanGitRepoPublicSkills : scanGitRepoSkills
      const result = await scanFn(gitUrl.trim())
      setScannedSkills(result.skills)

      if (result.skills.length === 0) {
        setGitError(t('skills.git_no_skills_found'))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('skills.git_download_failed')
      if (message.includes('not found') || message.includes('404')) {
        setGitError(t('skills.git_repo_not_found'))
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
      const importFn = isPublic ? importGitRepoPublicSkills : importGitRepoSkills
      const request = {
        repo_url: gitUrl.trim(),
        skill_paths: Array.from(selectedSkillPaths),
        ...(isPublic ? {} : { namespace }),
      }

      const result = await importFn(request)

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
      setGitError(err instanceof Error ? err.message : t('skills.git_download_failed'))
    } finally {
      setImporting(false)
    }
  }

  const handleConflictConfirm = async () => {
    setConflictDialogOpen(false)
    setImporting(true)

    try {
      const importFn = isPublic ? importGitRepoPublicSkills : importGitRepoSkills
      const request = {
        repo_url: gitUrl.trim(),
        skill_paths: Array.from(selectedSkillPaths),
        overwrite_names: Array.from(selectedOverwrites),
        ...(isPublic ? {} : { namespace }),
      }

      const result = await importFn(request)
      setImportResult(result)
      setShowResult(true)
    } catch (err) {
      setGitError(err instanceof Error ? err.message : t('skills.git_download_failed'))
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
      onClose(true)
    }
  }

  const handleClose = () => {
    if (!uploading && !scanning && !importing) {
      onClose(false)
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

  return (
    <>
      <Dialog open={open} onOpenChange={open => !open && handleClose()}>
        <DialogContent className="sm:max-w-[600px] bg-surface max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isEditMode ? t('skills.update_modal_title') : t('skills.upload_modal_title')}
            </DialogTitle>
            <DialogDescription>
              {isEditMode
                ? t('skills.update_modal_description')
                : t('skills.upload_modal_description')}
            </DialogDescription>
          </DialogHeader>

          {isEditMode ? (
            // Edit mode: only show upload form
            <UploadForm
              skillName={skillName}
              setSkillName={setSkillName}
              selectedFile={selectedFile}
              uploading={uploading}
              uploadProgress={uploadProgress}
              error={error}
              dragActive={dragActive}
              isEditMode={isEditMode}
              handleFileChange={handleFileChange}
              handleDrag={handleDrag}
              handleDrop={handleDrop}
              handleSubmit={handleSubmit}
              handleClose={handleClose}
              t={t}
            />
          ) : (
            // Create mode: show tabs
            <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'upload' | 'git')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload" className="flex items-center gap-2">
                  <UploadIcon className="w-4 h-4" />
                  {t('actions.upload')}
                </TabsTrigger>
                <TabsTrigger
                  value="git"
                  className="flex items-center gap-2"
                  onClick={resetGitState}
                >
                  <GitBranch className="w-4 h-4" />
                  {t('skills.git_import_tab')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="upload" className="mt-4">
                <UploadForm
                  skillName={skillName}
                  setSkillName={setSkillName}
                  selectedFile={selectedFile}
                  uploading={uploading}
                  uploadProgress={uploadProgress}
                  error={error}
                  dragActive={dragActive}
                  isEditMode={isEditMode}
                  handleFileChange={handleFileChange}
                  handleDrag={handleDrag}
                  handleDrop={handleDrop}
                  handleSubmit={handleSubmit}
                  handleClose={handleClose}
                  t={t}
                />
              </TabsContent>

              <TabsContent value="git" className="mt-4">
                {showResult && importResult ? (
                  <ImportResultView result={importResult} onDone={handleResultDone} t={t} />
                ) : (
                  <GitImportForm
                    gitUrl={gitUrl}
                    setGitUrl={setGitUrl}
                    scanning={scanning}
                    scannedSkills={scannedSkills}
                    selectedSkillPaths={selectedSkillPaths}
                    importing={importing}
                    gitError={gitError}
                    handleScanRepository={handleScanRepository}
                    handleSelectAll={handleSelectAll}
                    handleToggleSkill={handleToggleSkill}
                    handleImportSkills={handleImportSkills}
                    handleClose={handleClose}
                    t={t}
                  />
                )}
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Overwrite Confirmation Dialog (Upload) */}
      <AlertDialog open={overwriteDialogOpen} onOpenChange={setOverwriteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('skills.overwrite_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('skills.overwrite_confirm_message', { name: skillName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleOverwriteCancel}>
              {t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleOverwriteConfirm}>
              {t('skills.overwrite_confirm_button')}
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
              {t('skills.git_conflict_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('skills.git_conflict_description')}</AlertDialogDescription>
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
              {t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConflictConfirm}>
              {t('skills.git_import_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

interface UploadFormProps {
  skillName: string
  setSkillName: (name: string) => void
  selectedFile: File | null
  uploading: boolean
  uploadProgress: number
  error: string | null
  dragActive: boolean
  isEditMode: boolean
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleDrag: (e: React.DragEvent) => void
  handleDrop: (e: React.DragEvent) => void
  handleSubmit: () => void
  handleClose: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function UploadForm({
  skillName,
  setSkillName,
  selectedFile,
  uploading,
  uploadProgress,
  error,
  dragActive,
  isEditMode,
  handleFileChange,
  handleDrag,
  handleDrop,
  handleSubmit,
  handleClose,
  t,
}: UploadFormProps) {
  return (
    <div className="space-y-4">
      {/* Skill Name Input (only for create mode) */}
      {!isEditMode && (
        <div className="space-y-2">
          <Label htmlFor="skill-name">{t('skills.skill_name_required')}</Label>
          <Input
            id="skill-name"
            placeholder={t('skills.skill_name_placeholder')}
            value={skillName}
            onChange={e => setSkillName(e.target.value)}
            disabled={uploading}
          />
          <p className="text-xs text-text-muted">{t('skills.skill_name_hint')}</p>
        </div>
      )}

      {/* File Upload Area */}
      <div className="space-y-2">
        <Label>{t('skills.zip_package_required')}</Label>
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
              <p className="text-sm text-text-primary mb-1">{t('skills.drop_file_here')}</p>
              <p className="text-xs text-text-muted">{t('skills.max_file_size')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Upload Progress */}
      {uploading && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">{t('skills.upload_progress')}</span>
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
          <strong>{t('skills.requirements')}</strong>
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            <li>{t('skills.requirement_zip')}</li>
            <li>{t('skills.requirement_structure')}</li>
            <li>{t('skills.requirement_folder_name')}</li>
            <li>{t('skills.requirement_description')}</li>
            <li>{t('skills.requirement_optional')}</li>
            <li>{t('skills.requirement_size')}</li>
          </ul>
        </AlertDescription>
      </Alert>

      <DialogFooter>
        <Button variant="outline" onClick={handleClose} disabled={uploading}>
          {t('actions.cancel')}
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={uploading || !selectedFile}>
          {uploading
            ? t('skills.uploading')
            : isEditMode
              ? t('skills.update_skill')
              : t('actions.upload')}
        </Button>
      </DialogFooter>
    </div>
  )
}

interface GitImportFormProps {
  gitUrl: string
  setGitUrl: (url: string) => void
  scanning: boolean
  scannedSkills: GitSkillInfo[]
  selectedSkillPaths: Set<string>
  importing: boolean
  gitError: string | null
  handleScanRepository: () => void
  handleSelectAll: () => void
  handleToggleSkill: (path: string) => void
  handleImportSkills: () => void
  handleClose: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function GitImportForm({
  gitUrl,
  setGitUrl,
  scanning,
  scannedSkills,
  selectedSkillPaths,
  importing,
  gitError,
  handleScanRepository,
  handleSelectAll,
  handleToggleSkill,
  handleImportSkills,
  handleClose,
  t,
}: GitImportFormProps) {
  const isLoading = scanning || importing

  return (
    <div className="space-y-4">
      {/* Git URL Input */}
      <div className="space-y-2">
        <Label htmlFor="git-url">{t('skills.git_url_label')}</Label>
        <div className="flex gap-2">
          <Input
            id="git-url"
            placeholder={t('skills.git_url_placeholder')}
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
                {t('skills.git_scanning')}
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                {t('skills.git_scan_button')}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Error Message */}
      {gitError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {gitError}
            {gitError === t('skills.git_no_skills_found') && (
              <p className="mt-1 text-xs opacity-80">{t('skills.git_no_skills_hint')}</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Scanned Skills List */}
      {scannedSkills.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {t('skills.git_skills_found', { count: scannedSkills.length })}
            </span>
            <Button variant="ghost" size="sm" onClick={handleSelectAll}>
              {selectedSkillPaths.size === scannedSkills.length
                ? t('skills.git_deselect_all')
                : t('skills.git_select_all')}
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
                <label htmlFor={`skill-${skill.path}`} className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{skill.name}</span>
                    {skill.version && (
                      <span className="text-xs text-text-muted bg-muted px-1.5 py-0.5 rounded">
                        v{skill.version}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{skill.description}</p>
                  <p className="text-xs text-text-muted/70 mt-0.5">{skill.path}</p>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={handleClose} disabled={isLoading}>
          {t('actions.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleImportSkills}
          disabled={isLoading || selectedSkillPaths.size === 0}
        >
          {importing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('actions.loading')}
            </>
          ) : (
            t('skills.git_import_selected')
          )}
        </Button>
      </DialogFooter>
    </div>
  )
}

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
        <h3 className="text-lg font-semibold">{t('skills.git_import_result_title')}</h3>
      </div>

      <div className="space-y-2">
        {result.total_success > 0 && (
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle2 className="w-4 h-4" />
            <span>{t('skills.git_import_success', { count: result.total_success })}</span>
          </div>
        )}
        {result.total_skipped > 0 && (
          <div className="flex items-center gap-2 text-yellow-600">
            <AlertTriangle className="w-4 h-4" />
            <span>{t('skills.git_import_skipped', { count: result.total_skipped })}</span>
          </div>
        )}
        {result.total_failed > 0 && (
          <div className="space-y-1">
            <div
              className="flex items-center gap-2 text-red-600 cursor-pointer"
              onClick={() => setShowFailedDetails(!showFailedDetails)}
            >
              <XCircle className="w-4 h-4" />
              <span>{t('skills.git_import_failed', { count: result.total_failed })}</span>
            </div>
            {showFailedDetails && (
              <div className="ml-6 mt-2 space-y-1 text-sm text-text-muted">
                <p className="font-medium text-text-secondary">
                  {t('skills.git_import_failed_details')}:
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
          {t('actions.done')}
        </Button>
      </DialogFooter>
    </div>
  )
}
