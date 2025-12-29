// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useRef, useCallback, useState } from 'react';
import { Upload, X, FileText, AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useAttachment } from '@/hooks/useAttachment';
import { useTranslation } from '@/hooks/useTranslation';
import { SplitterSettingsSection, type SplitterConfig } from './SplitterSettingsSection';

interface DocumentUploadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadComplete: (
    attachmentId: number,
    file: File,
    splitterConfig?: Partial<SplitterConfig>
  ) => Promise<void>;
}

export function DocumentUpload({ open, onOpenChange, onUploadComplete }: DocumentUploadProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state, handleFileSelect, handleRemove, reset } = useAttachment();
  const [splitterConfig, setSplitterConfig] = useState<Partial<SplitterConfig>>({
    type: 'sentence',
    separator: '\n\n',
    chunk_size: 1024,
    chunk_overlap: 50,
  });

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleConfirm = async () => {
    if (state.attachment?.id && state.file) {
      try {
        await onUploadComplete(state.attachment.id, state.file, splitterConfig);
        reset();
        // Reset splitter config to defaults
        setSplitterConfig({
          type: 'sentence',
          separator: '\n\n',
          chunk_size: 1024,
          chunk_overlap: 50,
        });
      } catch {
        // Error handled by parent
      }
    }
  };

  const handleClose = () => {
    reset();
    // Reset splitter config to defaults
    setSplitterConfig({
      type: 'sentence',
      separator: '\n\n',
      chunk_size: 1024,
      chunk_overlap: 50,
    });
    onOpenChange(false);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.document.upload')}</DialogTitle>
        </DialogHeader>

        <div className="py-4 max-h-[60vh] overflow-y-auto">
          {!state.file ? (
            <div
              className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <Upload className="w-10 h-10 mx-auto mb-4 text-text-muted" />
              <p className="text-text-primary font-medium">
                {t('knowledge:document.document.dropzone')}
              </p>
              <p className="text-sm text-text-muted mt-2">
                {t('knowledge:document.document.supportedTypes')}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png,.gif,.bmp,.webp"
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3 bg-surface rounded-lg">
                <FileText className="w-8 h-8 text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-text-primary truncate">{state.file.name}</p>
                  <p className="text-sm text-text-muted">{formatFileSize(state.file.size)}</p>
                </div>
                {!state.isUploading && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleRemove}>
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>

              {state.isUploading && (
                <div className="space-y-2">
                  <Progress value={state.uploadProgress} />
                  <p className="text-sm text-text-muted text-center">
                    {t('knowledge:document.document.uploading')} {state.uploadProgress}%
                  </p>
                </div>
              )}

              {state.error && (
                <div className="flex items-center gap-2 p-3 bg-error/10 text-error rounded-lg text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{state.error}</span>
                </div>
              )}

              {state.attachment && !state.error && (
                <p className="text-sm text-success text-center">
                  {t('knowledge:document.document.uploadSuccess')}
                </p>
              )}

              {/* Advanced Settings - Splitter Configuration */}
              <Accordion type="single" collapsible className="border-none">
                <AccordionItem value="advanced" className="border-none">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline">
                    {t('knowledge:document.advancedSettings.title')}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      <SplitterSettingsSection
                        config={splitterConfig}
                        onChange={setSplitterConfig}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!state.attachment || state.isUploading || !!state.error}
          >
            {t('common:actions.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
