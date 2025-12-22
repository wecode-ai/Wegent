// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';

// Storage type configuration for extensibility
const STORAGE_TYPE_CONFIG = {
  elasticsearch: {
    defaultUrl: 'http://elasticsearch:9200',
    recommendedIndexMode: 'per_user' as const,
    authFields: {
      supportsUsernamePassword: true,
      supportsApiKey: false,
    },
  },
  qdrant: {
    defaultUrl: 'http://localhost:6333',
    recommendedIndexMode: 'per_dataset' as const,
    authFields: {
      supportsUsernamePassword: false,
      supportsApiKey: true,
    },
  },
} as const;
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { EyeIcon, EyeSlashIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { useTranslation } from '@/hooks/useTranslation';
import { retrieverApis, UnifiedRetriever, RetrieverCRD } from '@/apis/retrievers';

interface RetrieverEditDialogProps {
  open: boolean;
  retriever: UnifiedRetriever | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  scope?: 'personal' | 'group' | 'all';
  groupName?: string;
}

const RetrieverEditDialog: React.FC<RetrieverEditDialogProps> = ({
  open,
  retriever,
  onClose,
  toast,
  scope,
  groupName,
}) => {
  const { t } = useTranslation('common');
  const isEditing = !!retriever;
  const isGroupScope = scope === 'group';

  // Form state
  const [retrieverName, setRetrieverName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [storageType, setStorageType] = useState<'elasticsearch' | 'qdrant'>('elasticsearch');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [indexMode, setIndexMode] = useState<'fixed' | 'rolling' | 'per_dataset' | 'per_user'>(
    'per_user'
  );
  const [fixedIndexName, setFixedIndexName] = useState('');
  const [rollingStep, setRollingStep] = useState('5000');
  const [indexPrefix, setIndexPrefix] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Reset form when dialog opens/closes or retriever changes
  useEffect(() => {
    if (open) {
      if (retriever) {
        // Load existing retriever data
        const loadRetrieverData = async () => {
          try {
            const fullRetriever = await retrieverApis.getRetriever(
              retriever.name,
              retriever.namespace
            );
            setRetrieverName(fullRetriever.metadata.name);
            setDisplayName(fullRetriever.metadata.displayName || '');
            setStorageType(fullRetriever.spec.storageConfig.type as 'elasticsearch' | 'qdrant');
            setUrl(fullRetriever.spec.storageConfig.url);
            setUsername(fullRetriever.spec.storageConfig.username || '');
            setPassword(fullRetriever.spec.storageConfig.password || '');
            setApiKey(fullRetriever.spec.storageConfig.apiKey || '');
            setIndexMode(
              fullRetriever.spec.storageConfig.indexStrategy.mode as
                | 'fixed'
                | 'rolling'
                | 'per_dataset'
                | 'per_user'
            );
            setFixedIndexName(fullRetriever.spec.storageConfig.indexStrategy.fixedName || '');
            setRollingStep(
              String(fullRetriever.spec.storageConfig.indexStrategy.rollingStep || 5000)
            );
            setIndexPrefix(fullRetriever.spec.storageConfig.indexStrategy.prefix || 'wegent');
          } catch (error) {
            console.error('Failed to load retriever:', error);
            toast({
              variant: 'destructive',
              title: t('retrievers.errors.load_retrievers_failed'),
              description: (error as Error).message,
            });
          }
        };
        loadRetrieverData();
      } else {
        // Reset for new retriever
        setRetrieverName('');
        setDisplayName('');
        setStorageType('elasticsearch');
        setUrl('');
        setUsername('');
        setPassword('');
        setApiKey('');
        // Set recommended index mode based on storage type
        setIndexMode(STORAGE_TYPE_CONFIG[storageType].recommendedIndexMode);
        setFixedIndexName('');
        setRollingStep('5000');
        setIndexPrefix('wegent');
      }
      setShowPassword(false);
      setShowApiKey(false);
    }
  }, [open, retriever, toast, t]);

  const handleStorageTypeChange = (value: 'elasticsearch' | 'qdrant') => {
    setStorageType(value);
    const config = STORAGE_TYPE_CONFIG[value];
    setUrl(config.defaultUrl);
    // Set recommended index mode for new retrievers
    if (!isEditing) {
      setIndexMode(config.recommendedIndexMode);
    }
  };

  const handleTestConnection = async () => {
    if (!url) {
      toast({
        variant: 'destructive',
        title: t('retrievers.test_failed'),
        description: t('retrievers.url_required'),
      });
      return;
    }

    setTesting(true);
    try {
      const result = await retrieverApis.testConnection({
        storage_type: storageType,
        url,
        username: username || undefined,
        password: password || undefined,
        api_key: apiKey || undefined,
      });

      if (result.success) {
        toast({
          title: t('retrievers.test_success'),
          description: result.message,
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('retrievers.test_failed'),
          description: result.message,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('retrievers.test_failed'),
        description: (error as Error).message,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (isGroupScope && !isEditing && !groupName) {
      toast({
        variant: 'destructive',
        title: t('retrievers.group_required_title'),
        description: t('retrievers.group_required_message'),
      });
      return;
    }

    if (!retrieverName.trim()) {
      toast({
        variant: 'destructive',
        title: t('retrievers.name_required'),
      });
      return;
    }

    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
    if (!nameRegex.test(retrieverName)) {
      toast({
        variant: 'destructive',
        title: t('retrievers.name_invalid'),
        description: t('retrievers.name_invalid_hint'),
      });
      return;
    }

    if (!url.trim()) {
      toast({
        variant: 'destructive',
        title: t('retrievers.url_required'),
      });
      return;
    }

    // Validate index strategy fields
    if (indexMode === 'fixed' && !fixedIndexName.trim()) {
      toast({
        variant: 'destructive',
        title: t('retrievers.fixed_index_name_empty'),
      });
      return;
    }
    if (indexMode === 'rolling') {
      const step = parseInt(rollingStep);
      if (isNaN(step) || step <= 0) {
        toast({
          variant: 'destructive',
          title: t('retrievers.rolling_step_invalid'),
        });
        return;
      }
      if (!indexPrefix.trim()) {
        toast({
          variant: 'destructive',
          title: t('retrievers.rolling_prefix_required'),
        });
        return;
      }
    }

    if ((indexMode === 'per_dataset' || indexMode === 'per_user') && !indexPrefix.trim()) {
      toast({
        variant: 'destructive',
        title: t('retrievers.per_dataset_prefix_required'),
      });
      return;
    }

    setSaving(true);
    try {
      const retrieverCRD: RetrieverCRD = {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Retriever',
        metadata: {
          name: retrieverName.trim(),
          namespace: isGroupScope && groupName ? groupName : 'default',
          displayName: displayName.trim() || undefined,
        },
        spec: {
          storageConfig: {
            type: storageType,
            url: url.trim(),
            ...(username && { username: username.trim() }),
            ...(password && { password: password }),
            ...(apiKey && { apiKey: apiKey }),
            indexStrategy: {
              mode: indexMode,
              ...(indexMode === 'fixed' && { fixedName: fixedIndexName.trim() }),
              ...(indexMode === 'rolling' && { rollingStep: parseInt(rollingStep) }),
              ...(indexPrefix && { prefix: indexPrefix.trim() }),
            },
          },
        },
      };

      if (isEditing && retriever) {
        await retrieverApis.updateRetriever(retriever.name, retrieverCRD);
        toast({
          title: t('retrievers.update_success'),
        });
      } else {
        await retrieverApis.createRetriever(retrieverCRD);
        toast({
          title: t('retrievers.create_success'),
        });
      }

      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing
          ? t('retrievers.errors.update_failed')
          : t('retrievers.errors.create_failed'),
        description: (error as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('retrievers.edit') : t('retrievers.create')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Retriever Name and Display Name - Two columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="retrieverName" className="text-sm font-medium">
                {t('retrievers.retriever_id_required')}
              </Label>
              <Input
                id="retrieverName"
                value={retrieverName}
                onChange={e => setRetrieverName(e.target.value)}
                placeholder={t('retrievers.retriever_id_placeholder')}
                disabled={isEditing}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">
                {isEditing
                  ? t('retrievers.retriever_id_readonly')
                  : t('retrievers.retriever_id_hint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm font-medium">
                {t('retrievers.display_name')}
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('retrievers.display_name_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('retrievers.display_name_hint')}</p>
            </div>
          </div>

          {/* Storage Type */}
          <div className="space-y-2">
            <Label htmlFor="storage_type" className="text-sm font-medium">
              {t('retrievers.storage_type_required')}
            </Label>
            <Select value={storageType} onValueChange={handleStorageTypeChange}>
              <SelectTrigger id="storage_type" className="bg-base">
                <SelectValue placeholder={t('retrievers.storage_type_select')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="elasticsearch">
                  {t('retrievers.storage_type_elasticsearch')}
                </SelectItem>
                <SelectItem value="qdrant">{t('retrievers.storage_type_qdrant')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* URL */}
          <div className="space-y-2">
            <Label htmlFor="url" className="text-sm font-medium">
              {t('retrievers.connection_url_required')}
            </Label>
            <Input
              id="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder={
                storageType === 'elasticsearch'
                  ? t('retrievers.connection_url_placeholder_es')
                  : t('retrievers.connection_url_placeholder_qdrant')
              }
              className="bg-base"
            />
            <p className="text-xs text-text-muted">
              {storageType === 'elasticsearch'
                ? t('retrievers.connection_url_hint_es')
                : t('retrievers.connection_url_hint_qdrant')}
            </p>
          </div>

          {/* Authentication - Username/Password (Elasticsearch) */}
          {STORAGE_TYPE_CONFIG[storageType].authFields.supportsUsernamePassword && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-sm font-medium">
                  {t('retrievers.username')}
                </Label>
                <Input
                  id="username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={t('retrievers.username_placeholder')}
                  className="bg-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium">
                  {t('retrievers.password')}
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('retrievers.password_placeholder')}
                    className="bg-base pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeSlashIcon className="w-4 h-4" />
                    ) : (
                      <EyeIcon className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Authentication - API Key (Qdrant) */}
          {STORAGE_TYPE_CONFIG[storageType].authFields.supportsApiKey && (
            <div className="space-y-2">
              <Label htmlFor="apiKey" className="text-sm font-medium">
                {t('retrievers.api_key')}
              </Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('retrievers.api_key_placeholder')}
                  className="bg-base pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <EyeSlashIcon className="w-4 h-4" />
                  ) : (
                    <EyeIcon className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Index Strategy */}
          <div className="space-y-2">
            <Label htmlFor="index_mode" className="text-sm font-medium">
              {t('retrievers.index_strategy_required')}
            </Label>
            <Select
              value={indexMode}
              onValueChange={(value: string) =>
                setIndexMode(value as 'fixed' | 'rolling' | 'per_dataset' | 'per_user')
              }
            >
              <SelectTrigger id="index_mode" className="bg-base">
                <SelectValue placeholder={t('retrievers.index_strategy')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_user">
                  {t('retrievers.index_strategy_per_user')}
                  {STORAGE_TYPE_CONFIG[storageType].recommendedIndexMode === 'per_user' &&
                    ` (${t('wizard.recommended')})`}
                </SelectItem>
                <SelectItem value="per_dataset">
                  {t('retrievers.index_strategy_per_dataset')}
                  {STORAGE_TYPE_CONFIG[storageType].recommendedIndexMode === 'per_dataset' &&
                    ` (${t('wizard.recommended')})`}
                </SelectItem>
                <SelectItem value="fixed">{t('retrievers.index_strategy_fixed')}</SelectItem>
                <SelectItem value="rolling">{t('retrievers.index_strategy_rolling')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {indexMode === 'per_user' && t('retrievers.index_strategy_per_user_desc')}
              {indexMode === 'per_dataset' && t('retrievers.index_strategy_per_dataset_desc')}
              {indexMode === 'fixed' && t('retrievers.index_strategy_fixed_desc')}
              {indexMode === 'rolling' && t('retrievers.index_strategy_rolling_desc')}
            </p>
          </div>

          {/* Index Strategy Fields */}
          {indexMode === 'fixed' && (
            <div className="space-y-2">
              <Label htmlFor="fixedIndexName" className="text-sm font-medium">
                {t('retrievers.fixed_index_name_required')}
              </Label>
              <Input
                id="fixedIndexName"
                value={fixedIndexName}
                onChange={e => setFixedIndexName(e.target.value)}
                placeholder={t('retrievers.fixed_index_name_placeholder')}
                className="bg-base"
              />
            </div>
          )}

          {indexMode === 'rolling' && (
            <div className="space-y-2">
              <Label htmlFor="rollingStep" className="text-sm font-medium">
                {t('retrievers.rolling_step_required')}
              </Label>
              <Input
                id="rollingStep"
                type="number"
                value={rollingStep}
                onChange={e => setRollingStep(e.target.value)}
                placeholder={t('retrievers.rolling_step_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('retrievers.rolling_step_hint')}</p>
            </div>
          )}

          {(indexMode === 'rolling' || indexMode === 'per_dataset' || indexMode === 'per_user') && (
            <div className="space-y-2">
              <Label htmlFor="indexPrefix" className="text-sm font-medium">
                {t('retrievers.index_prefix')}
              </Label>
              <Input
                id="indexPrefix"
                value={indexPrefix}
                onChange={e => setIndexPrefix(e.target.value)}
                placeholder={t('retrievers.index_prefix_placeholder')}
                className="bg-base"
              />
              <p className="text-xs text-text-muted">{t('retrievers.index_prefix_hint')}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" onClick={handleTestConnection} disabled={testing || !url}>
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <BeakerIcon className="w-4 h-4 mr-1" />
            {t('retrievers.test_connection')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RetrieverEditDialog;
