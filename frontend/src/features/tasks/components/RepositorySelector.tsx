// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { Select, App } from 'antd';
import { FiGithub } from 'react-icons/fi';
import { GitRepoInfo, TaskDetail } from '@/types/api';
import { useUser } from '@/features/common/UserContext';
import { useRouter } from 'next/navigation';
import Modal from '@/features/common/Modal';
import { Button } from 'antd';
import { paths } from '@/config/paths';
import { useTranslation } from 'react-i18next';
import { getLastRepo } from '@/utils/userPreferences';
import { githubApis } from '@/apis/github';

interface RepositorySelectorProps {
  selectedRepo: GitRepoInfo | null;
  handleRepoChange: (repo: GitRepoInfo | null) => void;
  disabled: boolean;
  selectedTaskDetail?: TaskDetail | null;
}

export default function RepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
}: RepositorySelectorProps) {
  const { message } = App.useApp();
  const { user } = useUser();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Check if user has git_info configured
  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0;
  };

  /**
   * Load repositories from API
   * Returns the loaded repos for chaining
   */
  const loadRepositories = async (): Promise<GitRepoInfo[]> => {
    if (!hasGitInfo()) {
      return [];
    }

    setLoading(true);
    setError(null);

    try {
      const data = await githubApis.getRepositories();
      setRepos(data);
      setError(null);
      return data;
    } catch {
      setError('Failed to load repositories');
      message.error('Failed to load repositories');
      return [];
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (query: string) => {
    githubApis
      .searchRepositories(query)
      .then(data => {
        setRepos(data);
        setError(null);
      })
      .catch(() => {
        setError('Failed to search repositories');
        message.error('Failed to search repositories');
      })
      .finally(() => setLoading(false));
  };

  const handleChange = (value: { value: number; label: React.ReactNode } | undefined) => {
    if (!value) {
      handleRepoChange(null);
      return;
    }
    const repo = repos.find(r => r.git_repo_id === value.value);
    if (repo) {
      handleRepoChange(repo);
    }
  };

  const repoOptions = repos.map(repo => ({
    label: repo.git_repo,
    value: repo.git_repo_id,
  }));

  /**
   * Centralized repository selection logic
   * Handles all scenarios: mount, task selection, and restoration
   */
  useEffect(() => {
    let canceled = false;

    const selectRepository = async () => {
      const hasGit = hasGitInfo();
      console.log('[RepositorySelector] Effect triggered', {
        hasGitInfo: hasGit,
        user: user ? 'loaded' : 'null',
        gitInfoLength: user?.git_info?.length || 0,
        selectedTaskDetail: selectedTaskDetail?.git_repo || 'none',
        selectedRepo: selectedRepo?.git_repo || 'none',
        disabled,
        reposLength: repos.length,
      });

      if (!hasGit) {
        console.log('[RepositorySelector] No git info, exiting');
        return;
      }

      // Scenario 1: Task is selected - use task's repository
      if (selectedTaskDetail?.git_repo) {
        console.log(
          '[RepositorySelector] Scenario 1: Task selected, repo:',
          selectedTaskDetail.git_repo
        );

        // Check if already selected
        if (selectedRepo?.git_repo === selectedTaskDetail.git_repo) {
          console.log('[RepositorySelector] Already selected, no change needed');
          return;
        }

        // Try to find in existing repos list
        const repoInList = repos.find(r => r.git_repo === selectedTaskDetail.git_repo);
        if (repoInList) {
          console.log('[RepositorySelector] Found in list, selecting:', repoInList.git_repo);
          handleRepoChange(repoInList);
          return;
        }

        // Not found locally - search via API
        console.log('[RepositorySelector] Not in list, searching via API');
        try {
          setLoading(true);
          const result = await githubApis.searchRepositories(selectedTaskDetail.git_repo, {
            fullmatch: true,
          });

          if (canceled) return;

          if (result && result.length > 0) {
            const matched =
              result.find(r => r.git_repo === selectedTaskDetail.git_repo) ?? result[0];
            console.log('[RepositorySelector] Found via API, selecting:', matched.git_repo);
            handleRepoChange(matched);
            setError(null);
          } else {
            message.error('No repositories found');
          }
        } catch {
          setError('Failed to search repositories');
          message.error('Failed to search repositories');
        } finally {
          if (!canceled) {
            setLoading(false);
          }
        }
        return;
      }

      // Scenario 2: No task selected and no repo selected - restore from localStorage
      if (!selectedTaskDetail && !selectedRepo && !disabled) {
        console.log('[RepositorySelector] Scenario 2: Attempting to restore from localStorage');
        const lastRepo = getLastRepo();
        console.log('[RepositorySelector] Last repo from storage:', lastRepo);

        if (!lastRepo) {
          console.log('[RepositorySelector] No last repo in storage, exiting');
          return;
        }

        // Load repositories if not already loaded
        let repoList = repos;
        if (repoList.length === 0) {
          console.log('[RepositorySelector] Repos not loaded, loading now...');
          repoList = await loadRepositories();
          console.log('[RepositorySelector] Loaded repos count:', repoList.length);
          if (canceled || repoList.length === 0) {
            console.log('[RepositorySelector] Load failed or canceled');
            return;
          }
        }

        // Find and select the last repo
        const repoToRestore = repoList.find(r => r.git_repo_id === lastRepo.repoId);
        if (repoToRestore) {
          console.log(
            '[RepositorySelector] ✅ Restoring repo from localStorage:',
            repoToRestore.git_repo
          );
          handleRepoChange(repoToRestore);
        } else {
          console.log('[RepositorySelector] ❌ Repo not found in list, ID:', lastRepo.repoId);
        }
      } else {
        console.log('[RepositorySelector] Scenario 2 conditions not met:', {
          hasTaskDetail: !!selectedTaskDetail,
          hasSelectedRepo: !!selectedRepo,
          disabled,
        });
      }
    };

    selectRepository();

    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.git_repo, disabled, user]);

  /**
   * Handle dropdown open/close
   * Load repos on first open if not already loaded
   */
  const handleOpenChange = (visible: boolean) => {
    if (!hasGitInfo() && visible) {
      setIsModalOpen(true);
      return;
    }

    // Load repositories on first open if not already loaded
    if (visible && repos.length === 0 && hasGitInfo() && !loading) {
      loadRepositories();
    }
  };

  /**
   * Handle clear button click
   * Reload repositories to refresh the list
   */
  const handleClear = () => {
    loadRepositories();
  };

  /**
   * Navigate to settings page to configure git integration
   */
  const handleModalClick = () => {
    setIsModalOpen(false);
    router.push(paths.settings.integrations.getHref());
  };

  const { t } = useTranslation();

  return (
    <div className="flex items-center space-x-1 min-w-0">
      <FiGithub className="w-3 h-3 text-text-muted flex-shrink-0" />
      <Select
        labelInValue
        showSearch
        allowClear
        value={
          selectedRepo
            ? { value: selectedRepo.git_repo_id, label: selectedRepo.git_repo }
            : undefined
        }
        placeholder={
          <span className="text-sx truncate h-2">{t('branches.select_repository')}</span>
        }
        className="repository-selector min-w-0 truncate"
        style={{ width: 'auto', maxWidth: 200, display: 'inline-block', paddingRight: 8 }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: 200 } } }}
        classNames={{ popup: { root: 'repository-selector-dropdown custom-scrollbar' } }}
        disabled={disabled}
        loading={loading}
        filterOption={false}
        onSearch={handleSearch}
        onChange={handleChange}
        notFoundContent={
          error ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'rgb(var(--color-error))' }}>
              {error}
              {/* antd message.error is globally prompted */}
            </div>
          ) : !loading ? (
            <div className="px-3 py-2 text-sm text-text-muted">
              {repos.length === 0 ? 'Select Repository' : 'No repositories found'}
            </div>
          ) : null
        }
        options={repoOptions}
        open={hasGitInfo() ? undefined : false}
        onOpenChange={handleOpenChange}
        onClear={handleClear}
      />
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={t('guide.title')}
        maxWidth="sm"
      >
        <div className="flex flex-col items-center">
          <p className="text-sm text-text-secondary mb-6 text-center leading-relaxed">
            {t('guide.description')}
          </p>
          <Button
            type="primary"
            size="small"
            onClick={handleModalClick}
            style={{ minWidth: '100px' }}
          >
            {t('branches.set_token')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
