// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
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
import { Progress } from '@/components/ui/progress';
import { Loader2 } from 'lucide-react';
import { BeakerIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { useTranslation } from '@/hooks/useTranslation';
import {
  shellApis,
  UnifiedShell,
  ImageCheckResult,
  ValidationStage,
  ValidationStatusResponse,
  WorkspaceType,
  ShellResources,
} from '@/apis/shells';

// Polling configuration
const POLLING_INTERVAL = 2000; // 2 seconds
const MAX_POLLING_COUNT = 60; // 60 * 2s = 120 seconds timeout

// Stage progress mapping
const STAGE_PROGRESS: Record<ValidationStage, number> = {
  submitted: 10,
  pulling_image: 30,
  starting_container: 50,
  running_checks: 70,
  completed: 100,
};

// Memory options for persistent containers
const MEMORY_OPTIONS = ['2Gi', '4Gi', '8Gi', '16Gi'];

interface ShellEditProps {
  shell: UnifiedShell | null;
  onClose: () => void;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

const ShellEdit: React.FC<ShellEditProps> = ({ shell, onClose, toast }) => {
  const { t } = useTranslation('common');
  const isEditing = !!shell;

  // Form state
  const [name, setName] = useState(shell?.name || '');
  const [displayName, setDisplayName] = useState(shell?.displayName || '');
  const [baseShellRef, setBaseShellRef] = useState(shell?.baseShellRef || '');
  const [baseImage, setBaseImage] = useState(shell?.baseImage || '');
  const [originalBaseImage] = useState(shell?.baseImage || ''); // Track original value for edit mode
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>(
    (shell?.workspaceType as WorkspaceType) || 'ephemeral'
  );
  const [resources, setResources] = useState<ShellResources>(
    shell?.resources || { cpu: '2', memory: '4Gi' }
  );
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [_validationId, setValidationId] = useState<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const [validationStatus, setValidationStatus] = useState<{
    status: ValidationStage | 'error' | 'success' | 'failed';
    message: string;
    progress: number;
    valid?: boolean;
    checks?: ImageCheckResult[];
    errors?: string[];
  } | null>(null);

  // Available base shells (public local_engine shells)
  const [baseShells, setBaseShells] = useState<UnifiedShell[]>([]);
  const [loadingBaseShells, setLoadingBaseShells] = useState(true);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const fetchBaseShells = async () => {
      try {
        const shells = await shellApis.getLocalEngineShells();
        setBaseShells(shells);
      } catch (error) {
        console.error('Failed to fetch base shells:', error);
      } finally {
        setLoadingBaseShells(false);
      }
    };
    fetchBaseShells();
  }, []);

  // Start polling for validation status
  const startPolling = useCallback(
    (validationIdToCheck: string) => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }

      let count = 0;

      pollingRef.current = setInterval(async () => {
        count++;

        if (count >= MAX_POLLING_COUNT) {
          // Timeout
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          setValidating(false);
          setValidationStatus({
            status: 'error',
            message: t('shells.validation_timeout'),
            progress: 0,
            valid: false,
            errors: [t('shells.validation_timeout')],
          });
          toast({
            variant: 'destructive',
            title: t('shells.validation_failed'),
            description: t('shells.validation_timeout'),
          });
          return;
        }

        try {
          const result: ValidationStatusResponse =
            await shellApis.getValidationStatus(validationIdToCheck);

          // Update validation status display
          setValidationStatus({
            status: result.status,
            message: result.stage,
            progress: result.progress,
            valid: result.valid ?? undefined,
            checks: result.checks ?? undefined,
            errors: result.errors ?? undefined,
          });

          // Check if validation is completed
          if (result.status === 'completed') {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;
            setValidating(false);

            if (result.valid === true) {
              setValidationStatus({
                status: 'success',
                message: t('shells.validation_passed'),
                progress: 100,
                valid: true,
                checks: result.checks ?? undefined,
              });
              toast({
                title: t('shells.validation_success'),
              });
            } else {
              setValidationStatus({
                status: 'failed',
                message: result.errorMessage || t('shells.validation_not_passed'),
                progress: 100,
                valid: false,
                checks: result.checks ?? undefined,
                errors: result.errors ?? undefined,
              });
              toast({
                variant: 'destructive',
                title: t('shells.validation_failed'),
                description: result.errorMessage || t('shells.validation_not_passed'),
              });
            }
          }
        } catch (error) {
          console.error('Failed to poll validation status:', error);
          // Don't stop polling on transient errors, just log it
        }
      }, POLLING_INTERVAL);
    },
    [t, toast]
  );

  const handleValidateImage = async () => {
    if (!baseImage || !baseShellRef) {
      toast({
        variant: 'destructive',
        title: t('shells.errors.base_image_and_shell_required'),
      });
      return;
    }

    // Find the runtime for selected base shell
    const selectedBaseShell = baseShells.find(s => s.name === baseShellRef);
    if (!selectedBaseShell) {
      toast({
        variant: 'destructive',
        title: t('shells.errors.base_shell_not_found'),
      });
      return;
    }

    setValidating(true);
    setValidationStatus({
      status: 'submitted',
      message: t('shells.validation_stage_submitted'),
      progress: STAGE_PROGRESS.submitted,
    });

    try {
      const result = await shellApis.validateImage({
        image: baseImage,
        shellType: selectedBaseShell.shellType,
        shellName: name || undefined,
      });

      // Handle different response statuses
      if (result.status === 'skipped') {
        // Dify type - validation not needed
        setValidating(false);
        setValidationStatus({
          status: 'success',
          message: result.message,
          progress: 100,
          valid: true,
          checks: [],
          errors: [],
        });
        toast({
          title: t('shells.validation_skipped'),
          description: result.message,
        });
      } else if (result.status === 'submitted' && result.validationId) {
        // Async validation task submitted - start polling
        setValidationId(result.validationId);
        startPolling(result.validationId);
        toast({
          title: t('shells.validation_submitted'),
          description: t('shells.validation_async_hint'),
        });
      } else if (result.status === 'error') {
        // Error submitting validation
        setValidating(false);
        setValidationStatus({
          status: 'error',
          message: result.message,
          progress: 0,
          valid: false,
          errors: result.errors || [],
        });
        toast({
          variant: 'destructive',
          title: t('shells.validation_failed'),
          description: result.message,
        });
      }
    } catch (error) {
      setValidating(false);
      setValidationStatus({
        status: 'error',
        message: (error as Error).message,
        progress: 0,
        valid: false,
        errors: [(error as Error).message],
      });
      toast({
        variant: 'destructive',
        title: t('shells.validation_failed'),
        description: (error as Error).message,
      });
    }
  };

  // Check if save button should be disabled
  const isSaveDisabled = useCallback(() => {
    // If there's no baseImage, no validation needed
    if (!baseImage) return false;

    // In edit mode, if baseImage hasn't changed, no re-validation needed
    if (isEditing && baseImage === originalBaseImage) return false;

    // If there's a baseImage, validation must pass
    if (!validationStatus) return true;
    if (validationStatus.status !== 'success' || validationStatus.valid !== true) return true;

    return false;
  }, [baseImage, isEditing, originalBaseImage, validationStatus]);

  const getSaveButtonTooltip = useCallback(() => {
    if (isSaveDisabled()) {
      return t('shells.validation_required');
    }
    return undefined;
  }, [isSaveDisabled, t]);

  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: t('shells.errors.name_required'),
      });
      return;
    }

    // Validate name format (lowercase letters, numbers, and hyphens only)
    const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
    if (!nameRegex.test(name)) {
      toast({
        variant: 'destructive',
        title: t('shells.errors.name_invalid'),
      });
      return;
    }

    if (!isEditing) {
      if (!baseShellRef) {
        toast({
          variant: 'destructive',
          title: t('shells.errors.base_shell_required'),
        });
        return;
      }

      if (!baseImage.trim()) {
        toast({
          variant: 'destructive',
          title: t('shells.errors.base_image_required'),
        });
        return;
      }
    }

    setSaving(true);
    try {
      if (isEditing) {
        await shellApis.updateShell(shell.name, {
          displayName: displayName.trim() || undefined,
          baseImage: baseImage.trim() || undefined,
          workspaceType,
          resources: workspaceType === 'persistent' ? resources : undefined,
        });
        toast({
          title: t('shells.update_success'),
        });
      } else {
        await shellApis.createShell({
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          baseShellRef,
          baseImage: baseImage.trim(),
          workspaceType,
          resources: workspaceType === 'persistent' ? resources : undefined,
        });
        toast({
          title: t('shells.create_success'),
        });
      }

      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: isEditing ? t('shells.errors.update_failed') : t('shells.errors.create_failed'),
        description: (error as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleBack = useCallback(() => {
    // Clean up polling when going back
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      handleBack();
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleBack]);

  // Get stage display text
  const getStageDisplayText = (status: ValidationStage | 'error' | 'success' | 'failed') => {
    switch (status) {
      case 'submitted':
        return t('shells.validation_stage_submitted');
      case 'pulling_image':
        return t('shells.validation_stage_pulling');
      case 'starting_container':
        return t('shells.validation_stage_starting');
      case 'running_checks':
        return t('shells.validation_stage_checking');
      case 'completed':
      case 'success':
        return t('shells.validation_passed');
      case 'failed':
      case 'error':
        return t('shells.validation_not_passed');
      default:
        return status;
    }
  };

  return (
    <div className="flex flex-col w-full bg-surface rounded-lg px-2 py-4 min-h-[500px]">
      {/* Top Navigation */}
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mr-1"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || validating || isSaveDisabled()}
            title={getSaveButtonTooltip()}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </div>
      </div>

      {/* Form */}
      <div className="space-y-6 max-w-xl mx-2">
        {/* Shell Name */}
        <div className="space-y-2">
          <Label htmlFor="name" className="text-lg font-semibold text-text-primary">
            {t('shells.shell_name')} <span className="text-red-400">*</span>
          </Label>
          <Input
            id="name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="my-custom-shell"
            disabled={isEditing}
            className="bg-base"
          />
          <p className="text-xs text-text-muted">
            {isEditing ? t('shells.name_readonly_hint') : t('shells.name_hint')}
          </p>
        </div>

        {/* Display Name */}
        <div className="space-y-2">
          <Label htmlFor="displayName" className="text-lg font-semibold text-text-primary">
            {t('shells.display_name')}
          </Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={t('shells.display_name_placeholder')}
            className="bg-base"
          />
          <p className="text-xs text-text-muted">{t('shells.display_name_hint')}</p>
        </div>

        {/* Base Shell Reference */}
        <div className="space-y-2">
          <Label htmlFor="baseShellRef" className="text-lg font-semibold text-text-primary">
            {t('shells.base_shell')} <span className="text-red-400">*</span>
          </Label>
          <Select
            value={baseShellRef}
            onValueChange={setBaseShellRef}
            disabled={isEditing || loadingBaseShells}
          >
            <SelectTrigger className="bg-base">
              <SelectValue placeholder={t('shells.select_base_shell')} />
            </SelectTrigger>
            <SelectContent>
              {baseShells.map(shell => (
                <SelectItem key={shell.name} value={shell.name}>
                  <div className="flex items-center gap-2">
                    <span>{shell.displayName || shell.name}</span>
                    <span className="text-xs text-text-muted">({shell.shellType})</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">{t('shells.base_shell_hint')}</p>
        </div>

        {/* Workspace Type */}
        <div className="space-y-2">
          <Label htmlFor="workspaceType" className="text-lg font-semibold text-text-primary">
            {t('shells.workspace_type')}
          </Label>
          <Select
            value={workspaceType}
            onValueChange={(value: WorkspaceType) => setWorkspaceType(value)}
          >
            <SelectTrigger className="bg-base">
              <SelectValue placeholder={t('shells.select_workspace_type')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ephemeral">
                <div className="flex items-center gap-2">
                  <span>{t('shells.workspace_ephemeral')}</span>
                  <span className="text-xs text-text-muted">({t('shells.workspace_ephemeral_desc')})</span>
                </div>
              </SelectItem>
              <SelectItem value="persistent">
                <div className="flex items-center gap-2">
                  <span>{t('shells.workspace_persistent')}</span>
                  <span className="text-xs text-text-muted">({t('shells.workspace_persistent_desc')})</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">{t('shells.workspace_type_hint')}</p>
        </div>

        {/* Resource Configuration (only for persistent workspace) */}
        {workspaceType === 'persistent' && (
          <div className="space-y-4 p-4 border border-border rounded-lg bg-muted/20">
            <h4 className="text-base font-medium text-text-primary">{t('shells.resource_config')}</h4>

            {/* CPU */}
            <div className="space-y-2">
              <Label htmlFor="cpu" className="text-sm font-medium text-text-primary">
                {t('shells.cpu_cores')}
              </Label>
              <Input
                id="cpu"
                type="number"
                min="1"
                max="16"
                value={resources.cpu}
                onChange={e => setResources({ ...resources, cpu: e.target.value })}
                className="bg-base w-32"
              />
              <p className="text-xs text-text-muted">{t('shells.cpu_hint')}</p>
            </div>

            {/* Memory */}
            <div className="space-y-2">
              <Label htmlFor="memory" className="text-sm font-medium text-text-primary">
                {t('shells.memory')}
              </Label>
              <Select
                value={resources.memory}
                onValueChange={(value: string) => setResources({ ...resources, memory: value })}
              >
                <SelectTrigger className="bg-base w-32">
                  <SelectValue placeholder={t('shells.select_memory')} />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_OPTIONS.map(option => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-muted">{t('shells.memory_hint')}</p>
            </div>
          </div>
        )}

        {/* Base Image */}
        <div className="space-y-2">
          <Label htmlFor="baseImage" className="text-lg font-semibold text-text-primary">
            {t('shells.base_image')} <span className="text-red-400">*</span>
          </Label>
          <div className="flex gap-2">
            <Input
              id="baseImage"
              value={baseImage}
              onChange={e => {
                setBaseImage(e.target.value);
                // Reset validation status on change
                setValidationStatus(null);
                setValidationId(null);
                if (pollingRef.current) {
                  clearInterval(pollingRef.current);
                  pollingRef.current = null;
                }
              }}
              placeholder="ghcr.io/your-org/your-image:latest"
              className="bg-base flex-1"
            />
            <Button
              variant="outline"
              onClick={handleValidateImage}
              disabled={validating || !baseImage || !baseShellRef}
            >
              {validating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <BeakerIcon className="w-4 h-4 mr-1" />
              )}
              {t('shells.validate')}
            </Button>
          </div>
          <p className="text-xs text-text-muted">{t('shells.base_image_hint')}</p>

          {/* Validation Status */}
          {validationStatus && (
            <div
              className={`mt-3 p-3 rounded-md border ${
                validationStatus.status === 'success' || validationStatus.valid === true
                  ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                  : validationStatus.status === 'submitted' ||
                      validationStatus.status === 'pulling_image' ||
                      validationStatus.status === 'starting_container' ||
                      validationStatus.status === 'running_checks'
                    ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {validationStatus.status === 'success' || validationStatus.valid === true ? (
                  <CheckCircleIcon className="w-5 h-5 text-green-600 dark:text-green-400" />
                ) : validationStatus.status === 'submitted' ||
                  validationStatus.status === 'pulling_image' ||
                  validationStatus.status === 'starting_container' ||
                  validationStatus.status === 'running_checks' ? (
                  <Loader2 className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" />
                ) : (
                  <XCircleIcon className="w-5 h-5 text-red-600 dark:text-red-400" />
                )}
                <span
                  className={`font-medium ${
                    validationStatus.status === 'success' || validationStatus.valid === true
                      ? 'text-green-700 dark:text-green-300'
                      : validationStatus.status === 'submitted' ||
                          validationStatus.status === 'pulling_image' ||
                          validationStatus.status === 'starting_container' ||
                          validationStatus.status === 'running_checks'
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {getStageDisplayText(validationStatus.status)}
                </span>
              </div>

              {/* Progress bar for in-progress validation */}
              {validating && validationStatus.progress > 0 && (
                <div className="mb-2">
                  <Progress value={validationStatus.progress} className="h-2" />
                  <p className="text-xs text-text-muted mt-1">
                    {validationStatus.message} ({validationStatus.progress}%)
                  </p>
                </div>
              )}

              {!validating && (
                <p className="text-sm text-text-secondary">{validationStatus.message}</p>
              )}

              {validationStatus.checks && validationStatus.checks.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {validationStatus.checks.map((check, index) => (
                    <li key={index} className="flex items-center gap-2">
                      {check.status === 'pass' ? (
                        <CheckCircleIcon className="w-4 h-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <XCircleIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                      )}
                      <span className="text-text-secondary">
                        {check.name}
                        {check.version && ` (${check.version})`}
                        {check.message && `: ${check.message}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {validationStatus.errors && validationStatus.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-red-600 dark:text-red-400">
                  {validationStatus.errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Validation required hint when save is disabled */}
          {isSaveDisabled() && !validating && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
              {t('shells.validation_required')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShellEdit;
