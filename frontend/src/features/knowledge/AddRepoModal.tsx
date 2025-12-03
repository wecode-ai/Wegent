// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useMemo } from 'react';
import Modal from '@/features/common/Modal';
import { GitRepoInfo, GitBranch } from '@/types/api';
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { FiGithub, FiGitBranch } from 'react-icons/fi';
import { Loader2 } from 'lucide-react';
import { useUser } from '@/features/common/UserContext';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { paths } from '@/config/paths';
import { useTranslation } from 'react-i18next';
import { githubApis } from '@/apis/github';
import { useToast } from '@/hooks/use-toast';

interface AddRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  formData: {
    source_url: string;
    branch_name: string;
    language: string;
  };
  formErrors: Record<string, string>;
  isSubmitting: boolean;
  onRepoChange: (repo: GitRepoInfo | null) => void;
  onBranchChange: (branch: GitBranch | null) => void;
  onLanguageChange: (language: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  selectedRepo: GitRepoInfo | null;
  selectedBranch: GitBranch | null;
}

/**
 * Truncate text to a maximum length, keeping start and end with ellipsis in the middle
 */
function truncateMiddle(text: string, maxLength: number, startChars = 10, endChars = 10): string {
  if (text.length <= maxLength) {
    return text;
  }
  const start = text.slice(0, startChars);
  const end = text.slice(-endChars);
  return `${start}...${end}`;
}

export default function AddRepoModal({
  isOpen,
  onClose,
  formData,
  formErrors,
  isSubmitting,
  onRepoChange,
  onBranchChange,
  onLanguageChange,
  onSubmit,
  selectedRepo,
  selectedBranch,
}: AddRepoModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useUser();
  const router = useRouter();

  // Repository state
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [cachedRepos, setCachedRepos] = useState<GitRepoInfo[]>([]);

  // Branch state
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0;
  };

  // Load repositories when modal opens
  useEffect(() => {
    if (isOpen && hasGitInfo() && repos.length === 0) {
      loadRepositories();
    }
  }, [isOpen, user]);

  // Load branches when repo changes
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([]);
      onBranchChange(null);
      return;
    }

    setBranchLoading(true);
    setBranchError(null);

    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        setBranches(data);
        // Auto-select default branch
        const defaultBranch = data.find(b => b.default);
        if (defaultBranch) {
          onBranchChange(defaultBranch);
        }
      })
      .catch(() => {
        setBranchError(t('branches.load_failed'));
        toast({
          variant: 'destructive',
          title: t('branches.load_failed'),
        });
      })
      .finally(() => {
        setBranchLoading(false);
      });
  }, [selectedRepo]);

  const loadRepositories = async () => {
    setRepoLoading(true);
    setRepoError(null);

    try {
      const data = await githubApis.getRepositories();
      setRepos(data);
      setCachedRepos(data);
    } catch {
      setRepoError('Failed to load repositories');
      toast({
        variant: 'destructive',
        title: 'Failed to load repositories',
      });
    } finally {
      setRepoLoading(false);
    }
  };

  const handleRepoSearchChange = async (query: string) => {
    if (!query.trim()) {
      setRepos(cachedRepos);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);

    // Local search first
    const localResults = cachedRepos.filter(repo =>
      repo.git_repo.toLowerCase().includes(query.toLowerCase())
    );
    setRepos(localResults);

    // Remote search after delay
    try {
      const results = await githubApis.searchRepositories(query, {
        fullmatch: false,
        timeout: 30,
      });

      const mergedResults = [...localResults];
      results.forEach(remoteRepo => {
        if (!mergedResults.find(r => r.git_repo_id === remoteRepo.git_repo_id)) {
          mergedResults.push(remoteRepo);
        }
      });
      setRepos(mergedResults);
    } catch {
      console.error('Remote search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleRepoChange = (value: string) => {
    const repo = repos.find(r => r.git_repo_id === Number(value)) ||
                 cachedRepos.find(r => r.git_repo_id === Number(value));
    if (repo) {
      onRepoChange(repo);
    }
  };

  const handleBranchChange = (value: string) => {
    const branch = branches.find(b => b.name === value);
    if (branch) {
      onBranchChange(branch);
    }
  };

  const handleGoToSettings = () => {
    onClose();
    router.push(paths.settings.integrations.getHref());
  };

  // Convert repos to SearchableSelectItem format
  const repoItems: SearchableSelectItem[] = useMemo(() => {
    const items = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
      searchText: repo.git_repo,
    }));

    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString());
      if (!hasSelected) {
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
          searchText: selectedRepo.git_repo,
        });
      }
    }

    return items;
  }, [repos, selectedRepo]);

  // Convert branches to SearchableSelectItem format
  const branchItems: SearchableSelectItem[] = useMemo(() => {
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

  // Check if user has git info configured
  if (!hasGitInfo()) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={t('wiki.add_repository')} maxWidth="md">
        <div className="flex flex-col items-center py-8">
          <p className="text-sm text-text-secondary mb-6 text-center leading-relaxed">
            {t('guide.description')}
          </p>
          <Button variant="default" size="sm" onClick={handleGoToSettings}>
            {t('branches.set_token')}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('wiki.add_repository')} maxWidth="lg">
      <form onSubmit={onSubmit} className="space-y-5">
        {formErrors.submit && <div className="text-red-500 text-sm mb-4">{formErrors.submit}</div>}

        {/* Repository Selector */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('wiki.repository')}
          </label>
          <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-base">
            <FiGithub className="w-4 h-4 text-text-muted flex-shrink-0" />
            <div className="relative flex items-center gap-2 min-w-0 flex-1">
              <SearchableSelect
                value={selectedRepo?.git_repo_id.toString()}
                onValueChange={handleRepoChange}
                onSearchChange={handleRepoSearchChange}
                disabled={repoLoading}
                placeholder={t('branches.select_repository')}
                searchPlaceholder={t('branches.search_repository')}
                items={repoItems}
                loading={repoLoading}
                error={repoError}
                emptyText={t('branches.select_repository')}
                noMatchText={t('branches.no_match')}
                triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
                contentClassName="max-w-[400px]"
                renderTriggerValue={item => (
                  <span className="block" title={item?.label}>
                    {item?.label ? truncateMiddle(item.label, 40) : ''}
                  </span>
                )}
              />
              {isSearching && (
                <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 absolute right-0" />
              )}
            </div>
          </div>
          {formErrors.source_url && (
            <p className="mt-1 text-sm text-red-500">{formErrors.source_url}</p>
          )}
        </div>

        {/* Branch Selector */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('wiki.branch')}
          </label>
          <div className="flex items-center space-x-2 p-3 border border-border rounded-md bg-base">
            <FiGitBranch
              className={`w-4 h-4 text-text-muted flex-shrink-0 ${branchLoading ? 'animate-pulse' : ''}`}
            />
            <div className="relative flex-1">
              <SearchableSelect
                value={selectedBranch?.name}
                onValueChange={handleBranchChange}
                disabled={!selectedRepo || branchLoading || !!branchError}
                placeholder={t('branches.select_branch')}
                searchPlaceholder={t('branches.search_branch')}
                items={branchItems}
                loading={branchLoading}
                error={branchError}
                emptyText={branches.length === 0 ? t('branches.no_branch') : t('branches.select_branch')}
                noMatchText={t('branches.no_match')}
                triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
                contentClassName="max-w-[400px]"
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
          {formErrors.branch_name && (
            <p className="mt-1 text-sm text-red-500">{formErrors.branch_name}</p>
          )}
        </div>

        {/* Language Selector */}
        <div>
          <label htmlFor="language" className="block text-sm font-medium text-text-secondary mb-2">
            {t('wiki.document_language')}
          </label>
          <select
            id="language"
            name="language"
            value={formData.language}
            onChange={e => onLanguageChange(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-md bg-base text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="en">{t('wiki.language_en')}</option>
            <option value="zh">{t('wiki.language_zh')}</option>
          </select>
        </div>

        <div className="flex justify-end space-x-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-md hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary/40"
            disabled={isSubmitting}
          >
            {t('actions.cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            disabled={isSubmitting || !selectedRepo || !selectedBranch}
          >
            {isSubmitting ? (
              <div className="flex items-center">
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('wiki.adding')}
              </div>
            ) : (
              t('wiki.add_repository')
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
