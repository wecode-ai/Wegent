// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useCallback } from 'react';
import { Skill } from '@/types/api';
import { uploadSkill, updateSkill } from '@/apis/skills';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { UploadIcon, FileIcon, AlertCircle } from 'lucide-react';

interface SkillUploadModalProps {
  open: boolean;
  onClose: (saved: boolean) => void;
  skill?: Skill | null;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default function SkillUploadModal({ open, onClose, skill }: SkillUploadModalProps) {
  const [skillName, setSkillName] = useState(skill?.metadata.name || '');
  const [namespace] = useState('default');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const isEditMode = !!skill;

  const validateFile = (file: File): string | null => {
    if (!file.name.endsWith('.zip')) {
      return 'File must be a ZIP package (.zip)';
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File size exceeds 10MB limit (current: ${(file.size / (1024 * 1024)).toFixed(1)}MB)`;
    }
    return null;
  };

  const handleFileSelect = useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        setSelectedFile(null);
        return;
      }

      setSelectedFile(file);
      setError(null);

      // Auto-fill skill name from filename (without .zip extension)
      if (!isEditMode && !skillName) {
        const nameFromFile = file.name.replace(/\.zip$/i, '');
        setSkillName(nameFromFile);
      }
    },
    [isEditMode, skillName]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError('Please select a ZIP file');
      return;
    }

    if (!isEditMode && !skillName.trim()) {
      setError('Please enter a skill name');
      return;
    }

    setUploading(true);
    setError(null);
    setUploadProgress(0);

    try {
      if (isEditMode && skill) {
        const skillId = parseInt(skill.metadata.labels?.id || '0');
        await updateSkill(skillId, selectedFile, setUploadProgress);
      } else {
        await uploadSkill(selectedFile, skillName.trim(), namespace, setUploadProgress);
      }
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload skill');
    } finally {
      setUploading(false);
    }
  };

  const handleClose = () => {
    if (!uploading) {
      onClose(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px] bg-surface">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Update Skill' : 'Upload Skill'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Upload a new ZIP package to update this skill'
              : 'Upload a Claude Code Skill ZIP package containing SKILL.md'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Skill Name Input (only for create mode) */}
          {!isEditMode && (
            <div className="space-y-2">
              <Label htmlFor="skill-name">Skill Name *</Label>
              <Input
                id="skill-name"
                placeholder="e.g., python-debugger"
                value={skillName}
                onChange={e => setSkillName(e.target.value)}
                disabled={uploading}
              />
              <p className="text-xs text-text-muted">
                Unique identifier for this skill (lowercase, hyphens allowed)
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
                    Drop ZIP file here or click to browse
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
                <li>
                  ZIP file must contain a <code>SKILL.md</code> file
                </li>
                <li>
                  SKILL.md must have YAML frontmatter with <code>description</code> field
                </li>
                <li>
                  Optional fields: <code>version</code>, <code>author</code>, <code>tags</code>
                </li>
                <li>Maximum file size: 10MB</li>
              </ul>
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={uploading || !selectedFile}>
            {uploading ? 'Uploading...' : isEditMode ? 'Update' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
