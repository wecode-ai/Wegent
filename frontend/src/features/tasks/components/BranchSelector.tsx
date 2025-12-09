// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useMemo, useContext } from 'react';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { FiGitBranch } from 'react-icons/fi';
import { GitRepoInfo, GitBranch, TaskDetail } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { githubApis } from '@/apis/github';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { TaskContext } from '../contexts/taskContext';

/**
 * BranchSelector component
 * Refer to RepositorySelector, internally fetches branch data, unified loading/empty/error states
 */
interface BranchSelectorProps {
  selectedRepo: GitRepoInfo | null;
  selectedBranch: GitBranch | null;
  handleBranchChange: (branch: GitBranch | null) => void;
  disabled: boolean;
  // Optional: pass task detail directly instead of using context
  taskDetail?: TaskDetail | null;
}

export default function BranchSelector({
  selectedRepo,
  selectedBranch,
  handleBranchChange,
  disabled,
  taskDetail,
}: BranchSelectorProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // Used antd message.error for unified error prompt, no need for local error state
  const [error, setError] = useState<string | null>(null);
  const [userCleared, setUserCleared] = useState(false);

  // Try to get context, but don't throw if not available
  const taskContext = useContext(TaskContext);
  const selectedTaskDetail = taskDetail ?? taskContext?.selectedTaskDetail ?? null;

  // antd Select does not need dropdownDirection

  // Fetch branch list
  useEffect(() => {
    handleBranchChange(null);
    if (!selectedRepo) {
      setBranches([]);
      setError(null);
      setLoading(false);

      return;
    }
    let ignore = false;
    setLoading(true);
    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        if (!ignore) {
          setBranches(data);
          setError(null);
          setUserCleared(false);
        }
      })
      .catch(() => {
        if (!ignore) {
          setError(t('branches.load_failed'));
          toast({
            variant: 'destructive',
            title: t('branches.load_failed'),
          });
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo]);

  // Automatically set branch based on selectedTask
  useEffect(() => {
    if (!branches || branches.length === 0) return;
    if (userCleared) return;
    if (
      selectedTaskDetail &&
      'branch_name' in selectedTaskDetail &&
      selectedTaskDetail.branch_name
    ) {
      const foundBranch = branches.find(b => b.name === selectedTaskDetail.branch_name) || null;
      if (foundBranch) {
        handleBranchChange(foundBranch);
        return;
      }
    }
    // If there is no selectedTask or not found, select the default branch by default
    if (!selectedBranch) {
      const defaultBranch = branches.find(b => b.default);
      if (defaultBranch) {
        handleBranchChange(defaultBranch);
      } else {
        handleBranchChange(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, branches, userCleared]);

  useEffect(() => {
    setUserCleared(false);
  }, [selectedRepo, selectedTaskDetail?.branch_name]);

  // State merging
  const showLoading = loading;
  const showError = !!error;
  const showNoBranch = !showLoading && !showError && branches.length === 0;

  // Convert branches to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    return branches.map(branch => ({
      value: branch.name,
      label: branch.name,
      searchText: branch.name,
      content: (
        <span>
          {branch.name}
          {branch.default && (
            <span className="ml-2 text-green-400 text-[10px]">{t('branches.default')}</span>
          )}
        </span>
      ),
    }));
  }, [branches, t]);

  // Do not render (no branches, no selection, and no loading/error)
  if (!selectedBranch && branches.length === 0 && !showLoading && !showError) return null;

  // Construct branch options
  const handleChange = (value: string) => {
    const branch = branches.find(b => b.name === value);
    if (branch) {
      setUserCleared(false);
      handleBranchChange(branch);
    }
  };

  return (
    <div className="flex items-center space-x-2 min-w-0">
      <FiGitBranch
        className={`w-3 h-3 text-text-muted flex-shrink-0 ml-1 ${showLoading ? 'animate-pulse' : ''}`}
      />
      <div className="relative" style={{ width: isMobile ? 200 : 260 }}>
        <SearchableSelect
          value={selectedBranch?.name}
          onValueChange={handleChange}
          disabled={disabled || showError || showNoBranch || showLoading}
          placeholder={t('branches.select_branch')}
          searchPlaceholder={t('branches.search_branch')}
          items={selectItems}
          loading={showLoading}
          error={showError ? error : null}
          emptyText={showNoBranch ? t('branches.no_branch') : t('branches.select_branch')}
          noMatchText={t('branches.no_match')}
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName="max-w-[260px]"
          renderTriggerValue={item => {
            if (!item) return null;
            const branch = branches.find(b => b.name === item.value);
            return (
              <span className="truncate">
                {item.label}
                {branch?.default && ' (default)'}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}
