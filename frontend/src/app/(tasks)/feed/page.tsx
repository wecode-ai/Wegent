// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import TopNavigation from '@/features/layout/TopNavigation';
import TaskSidebar from '@/features/tasks/components/TaskSidebar';
import ResizableSidebar from '@/features/tasks/components/ResizableSidebar';
import CollapsedSidebarButtons from '@/features/tasks/components/CollapsedSidebarButtons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RssIcon,
  PlusIcon,
  SearchIcon,
  BellIcon,
  CheckCircleIcon,
  ClockIcon,
  ExternalLinkIcon,
} from 'lucide-react';
import { subscriptionsApi } from '@/apis/subscriptions';
import { Subscription, SubscriptionItem } from '@/types/subscription';
import { GithubStarButton } from '@/features/layout/GithubStarButton';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext';
import '@/app/tasks/tasks.css';
import '@/features/common/scrollbar.css';

type FeedTabType = 'feed' | 'subscriptions';

export default function FeedPage() {
  const { t } = useTranslation('feed');
  const router = useRouter();
  const isMobile = useIsMobile();
  const { clearAllStreams } = useChatStreamContext();

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<number | null>(null);
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'alerts'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Active tab
  const [activeTab, setActiveTab] = useState<FeedTabType>('feed');

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Get selected subscription
  const selectedSubscription = subscriptions.find(s => s.id === selectedSubscriptionId) || null;

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed');
    if (savedCollapsed === 'true') {
      setIsCollapsed(true);
    }
  }, []);

  // Load subscriptions
  const loadSubscriptions = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await subscriptionsApi.getSubscriptions({ limit: 100 });
      setSubscriptions(response.items);
      if (response.items.length > 0 && !selectedSubscriptionId) {
        setSelectedSubscriptionId(response.items[0].id);
      }
    } catch (error) {
      console.error('Failed to load subscriptions:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedSubscriptionId]);

  // Load items for selected subscription
  const loadItems = useCallback(async () => {
    if (!selectedSubscriptionId) return;

    try {
      setItemsLoading(true);
      const params: Record<string, unknown> = { limit: 50 };
      if (filter === 'unread') params.is_read = false;
      if (filter === 'alerts') params.should_alert = true;
      if (searchQuery) params.search = searchQuery;

      const response = await subscriptionsApi.getSubscriptionItems(
        selectedSubscriptionId,
        params as { is_read?: boolean; should_alert?: boolean; search?: string; limit?: number }
      );
      setItems(response.items);
    } catch (error) {
      console.error('Failed to load items:', error);
    } finally {
      setItemsLoading(false);
    }
  }, [selectedSubscriptionId, filter, searchQuery]);

  useEffect(() => {
    loadSubscriptions();
  }, [loadSubscriptions]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('task-sidebar-collapsed', String(newValue));
      return newValue;
    });
  };

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    clearAllStreams();
    router.replace('/feed');
  };

  const handleTabChange = (tab: string) => {
    if (tab === 'subscriptions') {
      router.push('/feed/subscriptions');
    } else {
      setActiveTab('feed');
    }
  };

  const handleMarkRead = async (item: SubscriptionItem) => {
    if (!selectedSubscriptionId || item.is_read) return;

    try {
      await subscriptionsApi.markItemRead(selectedSubscriptionId, item.id);
      setItems(items.map(i => (i.id === item.id ? { ...i, is_read: true } : i)));
      setSubscriptions(
        subscriptions.map(s =>
          s.id === selectedSubscriptionId
            ? { ...s, unread_count: Math.max(0, s.unread_count - 1) }
            : s
        )
      );
    } catch (error) {
      console.error('Failed to mark item as read:', error);
    }
  };

  const handleMarkAllRead = async () => {
    if (!selectedSubscriptionId) return;

    try {
      await subscriptionsApi.markAllItemsRead(selectedSubscriptionId);
      setItems(items.map(i => ({ ...i, is_read: true })));
      setSubscriptions(
        subscriptions.map(s => (s.id === selectedSubscriptionId ? { ...s, unread_count: 0 } : s))
      );
    } catch (error) {
      console.error('Failed to mark all items as read:', error);
    }
  };

  const totalUnread = subscriptions.reduce((sum, s) => sum + s.unread_count, 0);

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="chat"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="chat"
          variant="with-sidebar"
          title={t('title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
        >
          <div className="flex items-center gap-2">
            {totalUnread > 0 && (
              <Badge variant="error" className="rounded-full">
                {totalUnread}
              </Badge>
            )}
            {isMobile ? <ThemeToggle /> : <GithubStarButton />}
          </div>
        </TopNavigation>

        {/* Feed/Subscriptions Tabs */}
        <div className="px-6 pt-4 border-b border-border bg-surface">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList>
              <TabsTrigger value="feed">{t('feed')}</TabsTrigger>
              <TabsTrigger value="subscriptions">{t('subscriptions_manage')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-6">
          {/* Header with subscription selector */}
          <div className="flex items-center justify-between mb-6 max-w-4xl mx-auto">
            <div className="flex items-center gap-4">
              <Select
                value={selectedSubscriptionId?.toString() || ''}
                onValueChange={value => setSelectedSubscriptionId(parseInt(value))}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder={t('subscription')} />
                </SelectTrigger>
                <SelectContent>
                  {subscriptions.map(subscription => (
                    <SelectItem key={subscription.id} value={subscription.id.toString()}>
                      <div className="flex items-center gap-2">
                        <span>{subscription.name}</span>
                        {subscription.unread_count > 0 && (
                          <Badge variant="secondary" size="sm">
                            {subscription.unread_count}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSubscription && (
                <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
                  <CheckCircleIcon className="h-4 w-4 mr-1" />
                  {t('mark_all_read')}
                </Button>
              )}
            </div>
            <Button onClick={() => router.push('/feed/subscriptions')}>
              <PlusIcon className="h-4 w-4 mr-2" />
              {t('create_subscription')}
            </Button>
          </div>

          {/* Filters */}
          {selectedSubscription && (
            <div className="flex items-center gap-4 mb-6 max-w-4xl mx-auto">
              <div className="relative flex-1 max-w-md">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                <Input
                  placeholder={t('search_items')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Tabs value={filter} onValueChange={(v: string) => setFilter(v as typeof filter)}>
                <TabsList>
                  <TabsTrigger value="all">{t('all')}</TabsTrigger>
                  <TabsTrigger value="unread">{t('unread')}</TabsTrigger>
                  <TabsTrigger value="alerts">{t('alerts_only')}</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          {/* Items list */}
          <div className="max-w-4xl mx-auto">
            {isLoading ? (
              <div className="text-center py-12 text-text-secondary">Loading...</div>
            ) : subscriptions.length === 0 ? (
              <Card className="text-center py-12">
                <CardContent>
                  <RssIcon className="h-16 w-16 mx-auto mb-4 text-text-muted" />
                  <h2 className="text-lg font-semibold mb-2">{t('empty_subscriptions')}</h2>
                  <p className="text-text-secondary mb-4">{t('empty_subscriptions_hint')}</p>
                  <Button onClick={() => router.push('/feed/subscriptions')}>
                    <PlusIcon className="h-4 w-4 mr-2" />
                    {t('create_subscription')}
                  </Button>
                </CardContent>
              </Card>
            ) : itemsLoading ? (
              <div className="text-center py-8 text-text-secondary">Loading...</div>
            ) : items.length === 0 ? (
              <div className="text-center py-8">
                <RssIcon className="h-12 w-12 mx-auto mb-3 text-text-muted" />
                <p className="text-text-secondary">{t('empty_items')}</p>
                <p className="text-sm text-text-muted mt-1">{t('empty_items_hint')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {items.map(item => (
                  <Card
                    key={item.id}
                    className={`cursor-pointer transition-colors ${
                      !item.is_read ? 'bg-primary/5 border-primary/20' : ''
                    }`}
                    onClick={() => handleMarkRead(item)}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base font-medium flex items-center gap-2">
                          {item.should_alert && <BellIcon className="h-4 w-4 text-orange-500" />}
                          {!item.is_read && <span className="w-2 h-2 rounded-full bg-primary" />}
                          {item.title}
                        </CardTitle>
                        {item.source_url && (
                          <a
                            href={item.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-text-muted hover:text-primary"
                            onClick={e => e.stopPropagation()}
                          >
                            <ExternalLinkIcon className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {item.summary && (
                        <p className="text-sm text-text-secondary line-clamp-2">{item.summary}</p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                        <span className="flex items-center gap-1">
                          <ClockIcon className="h-3 w-3" />
                          {new Date(item.created_at).toLocaleString()}
                        </span>
                        {item.should_alert && item.alert_reason && (
                          <Badge variant="warning">{item.alert_reason}</Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
