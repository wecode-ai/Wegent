// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { ChevronDownIcon, ChevronRightIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { BranchDiffResponse, GitDiffFile } from '@/apis/tasks';
import { useTranslation } from '@/hooks/useTranslation';

interface FileChange {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  added_lines: number;
  removed_lines: number;
  diff_title: string;
}

interface DiffViewerProps {
  diffData: BranchDiffResponse | null;
  isLoading?: boolean;
  gitType: 'github' | 'gitlab';
  fileChanges?: FileChange[];
  showDiffContent?: boolean;
}

interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  diff: string;
  oldPath?: string;
  newPath?: string;
  isExpanded: boolean;
}

function _getStatusIcon(status: string) {
  const iconClasses = 'w-4 h-4';
  switch (status) {
    case 'added':
      return <DocumentTextIcon className={`${iconClasses} text-green-600`} />;
    case 'removed':
      return <DocumentTextIcon className={`${iconClasses} text-red-600`} />;
    case 'modified':
      return <DocumentTextIcon className={`${iconClasses} text-blue-600`} />;
    case 'renamed':
      return <DocumentTextIcon className={`${iconClasses} text-purple-600`} />;
    default:
      return <DocumentTextIcon className={`${iconClasses} text-gray-600`} />;
  }
}

function normalizeFileChanges(fileChanges: FileChange[]): DiffFile[] {
  return fileChanges.map(change => ({
    filename: change.new_path,
    status: change.new_file
      ? 'added'
      : change.deleted_file
        ? 'removed'
        : change.renamed_file
          ? 'renamed'
          : 'modified',
    additions: change.added_lines,
    deletions: change.removed_lines,
    changes: change.added_lines + change.removed_lines,
    diff: '',
    oldPath: change.old_path,
    newPath: change.new_path,
    isExpanded: false,
  }));
}

function normalizeGitFiles(files: GitDiffFile[]): DiffFile[] {
  return files.map(file => ({
    filename: file.filename,
    status:
      file.status === 'added'
        ? 'added'
        : file.status === 'removed'
          ? 'removed'
          : file.status === 'renamed'
            ? 'renamed'
            : 'modified',
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    diff: file.patch,
    oldPath: file.previous_filename,
    newPath: file.filename,
    isExpanded: false,
  }));
}

function renderDiffContent(diff: string) {
  if (!diff) return null;

  const lines = diff.split('\n');
  return lines.map((line, index) => {
    let lineClass = 'text-gray-700';
    let prefix = '';

    if (line.startsWith('@@')) {
      lineClass = 'text-purple-600 bg-purple-50';
    } else if (line.startsWith('+')) {
      lineClass = 'text-green-700 bg-green-50';
      prefix = '+';
    } else if (line.startsWith('-')) {
      lineClass = 'text-red-700 bg-red-50';
      prefix = '-';
    } else if (line.startsWith(' ')) {
      lineClass = 'text-gray-600';
      prefix = ' ';
    }

    return (
      <div key={index} className={`flex ${lineClass} text-sm font-mono`}>
        <span className="w-8 flex-shrink-0 text-right pr-2 select-none opacity-50">
          {index + 1}
        </span>
        <span className="flex-shrink-0 w-4 text-right pr-2 select-none">{prefix}</span>
        <span className="flex-1 whitespace-pre-wrap break-all">{line.substring(1)}</span>
      </div>
    );
  });
}

export default function DiffViewer({
  diffData,
  isLoading = false,
  gitType,
  fileChanges,
  showDiffContent = true,
}: DiffViewerProps) {
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const { t } = useTranslation('tasks');

  const _getStatusText = (status: string) => {
    switch (status) {
      case 'added':
        return t('workbench.file_status.added');
      case 'removed':
        return t('workbench.file_status.removed');
      case 'modified':
        return t('workbench.file_status.modified');
      case 'renamed':
        return t('workbench.file_status.renamed');
      default:
        return t('workbench.file_status.modified');
    }
  };

  // Normalize diff data when it changes
  useEffect(() => {
    if (fileChanges && fileChanges.length > 0) {
      // Use simple file changes without diff content
      setDiffFiles(normalizeFileChanges(fileChanges));
    } else if (diffData) {
      if (diffData.files) {
        setDiffFiles(normalizeGitFiles(diffData.files));
      }
    }
  }, [diffData, gitType, fileChanges]);

  const toggleFile = (index: number) => {
    setDiffFiles(prev =>
      prev.map((file, i) => (i === index ? { ...file, isExpanded: !file.isExpanded } : file))
    );
  };

  const toggleAllFiles = (expanded: boolean) => {
    setDiffFiles(prev => prev.map(file => ({ ...file, isExpanded: expanded })));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <span className="ml-3 text-text-muted">{t('workbench.loading_diff_message')}</span>
      </div>
    );
  }

  if ((!diffData && !fileChanges) || diffFiles.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center">
        <p className="text-text-muted">{t('workbench.no_changes_found')}</p>
      </div>
    );
  }

  const totalAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0);
  const totalChanges = diffFiles.reduce((sum, file) => sum + file.changes, 0);
  const allExpanded = diffFiles.length > 0 && diffFiles.every(file => file.isExpanded);
  const hasDiffContent = diffFiles.some(file => file.diff);

  return (
    <div className="space-y-4">
      {/* Summary - only show if we have detailed diff data */}
      {showDiffContent && hasDiffContent && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-muted">
                  {t('workbench.changes')}:
                </span>
                <span className="text-sm font-semibold text-text-primary">{totalChanges}</span>
              </div>
              {totalAdditions > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-green-600">
                    {t('workbench.additions')}:
                  </span>
                  <span className="text-sm font-semibold text-green-600">+{totalAdditions}</span>
                </div>
              )}
              {totalDeletions > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-red-600">
                    {t('workbench.deletions')}:
                  </span>
                  <span className="text-sm font-semibold text-red-600">-{totalDeletions}</span>
                </div>
              )}
            </div>
            <button
              onClick={() => toggleAllFiles(!allExpanded)}
              className="text-sm text-primary hover:text-primary/80 transition-colors"
            >
              {allExpanded ? t('workbench.collapse_all') : t('workbench.expand_all')}
            </button>
          </div>
        </div>
      )}

      {/* Files */}
      <div className="space-y-2">
        {diffFiles.map((file, index) => {
          const totalFileChanges = file.additions + file.deletions;
          const addedPercent = totalFileChanges > 0 ? (file.additions / totalFileChanges) * 100 : 0;
          const removedPercent =
            totalFileChanges > 0 ? (file.deletions / totalFileChanges) * 100 : 0;

          return (
            <div key={index} className="border border-border rounded-lg overflow-hidden">
              {/* File header */}
              <div
                className={`flex items-center justify-between p-3 bg-muted transition-colors ${
                  showDiffContent && file.diff ? 'hover:bg-muted/80 cursor-pointer' : ''
                }`}
                onClick={() => showDiffContent && file.diff && toggleFile(index)}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* File path */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-text-primary truncate">
                        {file.filename}
                      </span>
                      {file.status === 'added' && (
                        <span className="inline-flex items-center rounded-md bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
                          {t('workbench.file_status.new')}
                        </span>
                      )}
                      {file.status === 'removed' && (
                        <span className="inline-flex items-center rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
                          {t('workbench.file_status.deleted')}
                        </span>
                      )}
                      {file.status === 'renamed' && (
                        <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20">
                          {t('workbench.file_status.renamed')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {/* Added/Removed lines */}
                    <div className="flex items-center gap-2 text-sm font-mono">
                      {file.additions > 0 && (
                        <span className="text-green-600">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="text-red-600">-{file.deletions}</span>
                      )}
                    </div>

                    {/* Visual bar */}
                    <div className="flex items-center gap-0.5 w-20">
                      {totalFileChanges > 0 && (
                        <>
                          {/* Green bars for additions */}
                          {Array.from({ length: Math.ceil(addedPercent / 20) }).map((_, i) => (
                            <div key={`add-${i}`} className="h-2 w-2 rounded-sm bg-green-500" />
                          ))}
                          {/* Red bars for deletions */}
                          {Array.from({ length: Math.ceil(removedPercent / 20) }).map((_, i) => (
                            <div key={`del-${i}`} className="h-2 w-2 rounded-sm bg-red-500" />
                          ))}
                          {/* Gray bars to fill remaining space */}
                          {Array.from({
                            length: Math.max(
                              0,
                              5 - Math.ceil(addedPercent / 20) - Math.ceil(removedPercent / 20)
                            ),
                          }).map((_, i) => (
                            <div key={`empty-${i}`} className="h-2 w-2 rounded-sm bg-border" />
                          ))}
                        </>
                      )}
                    </div>

                    {/* Expand/collapse icon - only show if diff content is available */}
                    {showDiffContent && file.diff && (
                      <>
                        {file.isExpanded ? (
                          <ChevronDownIcon className="w-4 h-4 text-text-muted" />
                        ) : (
                          <ChevronRightIcon className="w-4 h-4 text-text-muted" />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Diff content - only show if available and expanded */}
              {showDiffContent && file.isExpanded && file.diff && (
                <div className="border-t border-border bg-surface">
                  <div className="p-4 overflow-x-auto">
                    <div className="inline-block min-w-full">{renderDiffContent(file.diff)}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
