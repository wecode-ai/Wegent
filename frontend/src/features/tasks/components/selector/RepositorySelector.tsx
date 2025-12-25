// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

/**
 * Truncate text to a maximum length, keeping start and end with ellipsis in the middle
 * @param text - The text to truncate
 * @param maxLength - Maximum length of the text
 * @param startChars - Number of characters to keep at the start (default: 10)
 * @param endChars - Number of characters to keep at the end (default: 8)
 * @returns Truncated text with ellipsis in the middle if needed
 */
function truncateMiddle(text: string, maxLength: number, startChars = 8, endChars = 10): string {
  if (text.length <= maxLength) {
    return text;
  }

  const start = text.slice(0, startChars);
  const end = text.slice(-endChars);
  return `${start}...${end}`;
}
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select';
import { FiGithub } from 'react-icons/fi';
import { Loader2, RefreshCw } from 'lucide-react';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { GitRepoInfo, TaskDetail } from '@/types/api';
import { useUser } from '@/features/common/UserContext';
import { useRouter } from 'next/navigation';
import { paths } from '@/config/paths';
import { useTranslation } from 'react-i18next';
import { getLastRepo } from '@/utils/userPreferences';
import { githubApis } from '@/apis/github';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface RepositorySelectorProps {
  selectedRepo: GitRepoInfo | null;
  handleRepoChange: (repo: GitRepoInfo | null) => void;
  disabled: boolean;
  selectedTaskDetail?: TaskDetail | null;
  /** When true, the selector will take full width of its container */
  fullWidth?: boolean;
  /** When true, display only icon without text (for responsive collapse) */
  compact?: boolean;
}

export default function RepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
  fullWidth = false,
  compact = false,
}: RepositorySelectorProps) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const { user } = useUser();
  const router = useRouter();
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [cachedRepos, setCachedRepos] = useState<GitRepoInfo[]>([]); // Cache initially loaded repositories
  const [loading, setLoading] = useState<boolean>(false);
  const [isSearching, setIsSearching] = useState<boolean>(false); // User is searching (includes waiting period)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false); // Refreshing repository cache
  const [currentSearchQuery, setCurrentSearchQuery] = useState<string>(''); // Current search query for refresh
  const [error, setError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
      setCachedRepos(data); // Cache initial repository list
      setError(null);
      return data;
    } catch {
      setError('Failed to load repositories');
      toast({
        variant: 'destructive',
        title: 'Failed to load repositories',
      });
      return [];
    } finally {
      setLoading(false);
    }
  };

  /**
   * Search repositories locally (in cache)
   */
  const searchLocalRepos = useCallback(
    (query: string): GitRepoInfo[] => {
      if (!query.trim()) {
        return cachedRepos;
      }
      const lowerQuery = query.toLowerCase();
      return cachedRepos.filter(repo => repo.git_repo.toLowerCase().includes(lowerQuery));
    },
    [cachedRepos]
  );

  /**
   * Search repositories remotely (delayed execution)
   */
  const searchRemoteRepos = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setRepos(cachedRepos);
        return;
      }

      try {
        const results = await githubApis.searchRepositories(query, {
          fullmatch: false,
          timeout: 30,
        });

        // Merge local and remote results, remove duplicates
        const localResults = searchLocalRepos(query);
        const mergedResults = [...localResults];

        results.forEach(remoteRepo => {
          if (!mergedResults.find(r => r.git_repo_id === remoteRepo.git_repo_id)) {
            mergedResults.push(remoteRepo);
          }
        });

        setRepos(mergedResults);
        setError(null);
      } catch {
        // Keep local results when remote search fails
        console.error('Remote search failed, keeping local results');
      } finally {
        setIsSearching(false); // Hide loading indicator when remote search completes
      }
    },
    [cachedRepos, searchLocalRepos]
  );

  /**
   * Handle search input changes
   */
  const handleSearchChange = useCallback(
    (query: string) => {
      // Track current search query for refresh functionality
      setCurrentSearchQuery(query);

      // Clear previous timer
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // If search is empty, restore cached repos immediately
      if (!query.trim()) {
        setRepos(cachedRepos);
        setIsSearching(false);
        return;
      }

      // Show loading indicator immediately when user starts typing
      setIsSearching(true);

      // Immediately perform local search
      const localResults = searchLocalRepos(query);
      setRepos(localResults);

      // Delay 1 second before remote search (regardless of local results)
      searchTimeoutRef.current = setTimeout(() => {
        searchRemoteRepos(query);
      }, 1000);
    },
    [searchLocalRepos, searchRemoteRepos, cachedRepos]
  );

  /**
   * Handle refresh cache button click
   * Clears backend Redis cache and reloads repository list
   */
  const handleRefreshCache = useCallback(async () => {
    if (isRefreshing) return; // Prevent duplicate clicks

    setIsRefreshing(true);
    try {
      // 1. Call backend API to clear cache
      await githubApis.refreshRepositories();

      // 2. Reload data based on current search state
      if (currentSearchQuery.trim()) {
        // Has search query: re-execute search
        const results = await githubApis.searchRepositories(currentSearchQuery, {
          fullmatch: false,
          timeout: 30,
        });
        setRepos(results);
      } else {
        // No search query: reload all repositories
        const data = await githubApis.getRepositories();
        setRepos(data);
        setCachedRepos(data);
      }

      toast({ title: t('branches.refresh_success') });
    } catch {
      toast({ variant: 'destructive', title: t('branches.refresh_failed') });
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, currentSearchQuery, toast, t]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  const handleChange = (value: string) => {
    // First try to find in current repos list (includes search results)
    let repo = repos.find(r => r.git_repo_id === Number(value));

    // If not found in current list, try cached repos (all initially loaded repos)
    if (!repo) {
      repo = cachedRepos.find(r => r.git_repo_id === Number(value));
    }

    if (repo) {
      handleRepoChange(repo);
    }
  };

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
            toast({
              variant: 'destructive',
              title: 'No repositories found',
            });
          }
        } catch {
          setError('Failed to search repositories');
          toast({
            variant: 'destructive',
            title: 'Failed to search repositories',
          });
        } finally {
          if (!canceled) {
            setLoading(false);
          }
        }
        return;
      }

      // Scenario 2: No task selected and no repo selected - load repos and optionally restore from localStorage
      if (!selectedTaskDetail && !selectedRepo && !disabled) {
        console.log('[RepositorySelector] Scenario 2: Load repos and restore from localStorage');

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

        // Try to restore from localStorage if available
        const lastRepo = getLastRepo();
        console.log('[RepositorySelector] Last repo from storage:', lastRepo);

        if (lastRepo) {
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
          console.log(
            '[RepositorySelector] No last repo in storage, repos loaded but no selection'
          );
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
  }, [selectedTaskDetail?.git_repo, disabled, user, repos.length]);

  /**
   * Navigate to settings page to configure git integration
   */
  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref());
  };
  const isMobile = useIsMobile();

  // Convert repos to SearchableSelectItem format
  // Always include the selected repo to ensure it displays correctly
  const selectItems: SearchableSelectItem[] = useMemo(() => {
    const items = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
      searchText: repo.git_repo,
    }));

    // Ensure selected repo is in the items list
    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString());
      if (!hasSelected) {
        // Add selected repo at the beginning if not in current list
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
          searchText: selectedRepo.git_repo,
        });
      }
    }

    return items;
  }, [repos, selectedRepo]);

  // Tooltip content for repository selector
  // In compact mode, show selected repo name in tooltip
  const tooltipContent =
    compact && selectedRepo
      ? `${t('repos.repository_tooltip', '选择代码仓库')}: ${selectedRepo.git_repo}`
      : t('repos.repository_tooltip', '选择代码仓库');

  // In compact mode, only show the icon button
  if (compact) {
    return (
      <div className="flex items-center min-w-0" data-tour="repo-selector">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled || loading}
                className={cn(
                  'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                  'transition-colors',
                  'text-text-muted hover:text-text-primary hover:bg-muted',
                  loading ? 'animate-pulse' : '',
                  'focus:outline-none focus:ring-0',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
                onClick={() => {
                  const trigger = document.querySelector(
                    '[data-repo-trigger]'
                  ) as HTMLButtonElement;
                  trigger?.click();
                }}
              >
                <FiGithub className="w-4 h-4 flex-shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{tooltipContent}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {/* Hidden SearchableSelect for popover functionality */}
        <div className="hidden">
          <SearchableSelect
            value={selectedRepo?.git_repo_id.toString()}
            onValueChange={handleChange}
            onSearchChange={handleSearchChange}
            disabled={disabled || loading}
            placeholder={t('branches.select_repository')}
            searchPlaceholder={t('branches.search_repository')}
            items={selectItems}
            loading={loading}
            error={error}
            emptyText={t('branches.select_repository')}
            noMatchText={t('branches.no_match')}
            contentClassName="max-w-[280px]"
            footer={
              <div className="border-t border-border bg-base flex items-center justify-between px-2.5 py-2 text-xs text-text-secondary">
                <div
                  className="cursor-pointer group flex items-center space-x-2 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1 py-0.5"
                  onClick={handleIntegrationClick}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleIntegrationClick();
                    }
                  }}
                >
                  <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                  <span className="font-medium group-hover:text-text-primary">
                    {t('branches.configure_integration')}
                  </span>
                </div>
                <div
                  className="cursor-pointer flex items-center gap-1.5 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1.5 py-0.5"
                  onClick={e => {
                    e.stopPropagation();
                    handleRefreshCache();
                  }}
                  role="button"
                  tabIndex={0}
                  title={t('branches.load_more')}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      handleRefreshCache();
                    }
                  }}
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
                  <span className="text-xs">
                    {isRefreshing ? t('branches.refreshing') : t('actions.refresh')}
                  </span>
                </div>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('flex items-center min-w-0', fullWidth && 'w-full')}
      data-tour="repo-selector"
      style={fullWidth ? undefined : { maxWidth: isMobile ? 200 : 280 }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled || loading}
              className={cn(
                'flex items-center gap-1 min-w-0 rounded-md px-2 py-1',
                'transition-colors',
                'text-text-muted hover:text-text-primary hover:bg-muted',
                loading ? 'animate-pulse' : '',
                'focus:outline-none focus:ring-0',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
              onClick={() => {
                // Trigger the SearchableSelect to open
                const trigger = document.querySelector('[data-repo-trigger]') as HTMLButtonElement;
                trigger?.click();
              }}
            >
              <FiGithub className="w-4 h-4 flex-shrink-0" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className={cn('relative flex items-center gap-2 min-w-0 flex-1', fullWidth && 'w-full')}>
        <SearchableSelect
          value={selectedRepo?.git_repo_id.toString()}
          onValueChange={handleChange}
          onSearchChange={handleSearchChange}
          disabled={disabled || loading}
          placeholder={t('branches.select_repository')}
          searchPlaceholder={t('branches.search_repository')}
          items={selectItems}
          loading={loading}
          error={error}
          emptyText={t('branches.select_repository')}
          noMatchText={t('branches.no_match')}
          className={fullWidth ? 'w-full' : undefined}
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName={fullWidth ? 'max-w-[400px]' : 'max-w-[280px]'}
          renderTriggerValue={item => (
            <span className="block" title={item?.label}>
              {item?.label ? truncateMiddle(item.label, fullWidth ? 60 : isMobile ? 20 : 25) : ''}
            </span>
          )}
          footer={
            <div className="border-t border-border bg-base flex items-center justify-between px-2.5 py-2 text-xs text-text-secondary">
              <div
                className="cursor-pointer group flex items-center space-x-2 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1 py-0.5"
                onClick={handleIntegrationClick}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleIntegrationClick();
                  }
                }}
              >
                <Cog6ToothIcon className="w-4 h-4 text-text-secondary group-hover:text-text-primary" />
                <span className="font-medium group-hover:text-text-primary">
                  {t('branches.configure_integration')}
                </span>
              </div>
              <div
                className="cursor-pointer flex items-center gap-1.5 hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-1.5 py-0.5"
                onClick={e => {
                  e.stopPropagation();
                  handleRefreshCache();
                }}
                role="button"
                tabIndex={0}
                title={t('branches.load_more')}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRefreshCache();
                  }
                }}
              >
                <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
                <span className="text-xs">
                  {isRefreshing ? t('branches.refreshing') : t('actions.refresh')}
                </span>
              </div>
            </div>
          }
        />
        {isSearching && (
          <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 absolute right-0" />
        )}
      </div>
    </div>
  );
}
