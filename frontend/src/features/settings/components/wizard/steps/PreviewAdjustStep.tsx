// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/hooks/useTranslation';
import { Send, RefreshCw, MessageSquare, FileText, Wand2, Cpu, Sparkles } from 'lucide-react';
import { modelApis, type UnifiedModel } from '@/apis/models';
import type { TestConversation } from '../types';
import type { ModelRecommendation } from '@/apis/wizard';
import GeneratingLoader from './GeneratingLoader';
import MessageBubble, { type Message } from '@/features/tasks/components/MessageBubble';
import { useTheme } from '@/features/theme/ThemeProvider';
import '../wizard-animations.css';

interface PreviewAdjustStepProps {
  systemPrompt: string;
  testConversations: TestConversation[];
  isTestingPrompt: boolean;
  isIteratingPrompt: boolean;
  selectedModel: ModelRecommendation | null;
  onTestPrompt: (testMessage: string) => Promise<void>;
  onIteratePrompt: (feedback: string) => Promise<void>;
  onPromptChange: (prompt: string) => void;
  onModelChange: (model: ModelRecommendation | null) => void;
  onClearConversations: () => void;
  isLoading: boolean;
  promptRefreshed?: boolean;
}

export default function PreviewAdjustStep({
  systemPrompt,
  testConversations,
  isTestingPrompt,
  isIteratingPrompt,
  selectedModel,
  onTestPrompt,
  onIteratePrompt,
  onPromptChange,
  onModelChange,
  onClearConversations,
  isLoading,
  promptRefreshed = false,
}: PreviewAdjustStepProps) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const [testMessage, setTestMessage] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [availableModels, setAvailableModels] = useState<UnifiedModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showRefreshSuccess, setShowRefreshSuccess] = useState(false);
  const [showIteratePanel, setShowIteratePanel] = useState(true); // Show by default on page load
  const iteratePanelRef = useRef<HTMLDivElement>(null);

  // Handle prompt refresh animation when promptRefreshed changes
  useEffect(() => {
    if (promptRefreshed) {
      setIsRefreshing(true);
      setShowRefreshSuccess(true);

      // Clear conversations after a short delay for animation
      const clearTimer = setTimeout(() => {
        onClearConversations();
      }, 300);

      // End refresh animation
      const refreshTimer = setTimeout(() => {
        setIsRefreshing(false);
      }, 800);

      // Hide success message
      const successTimer = setTimeout(() => {
        setShowRefreshSuccess(false);
      }, 2500);

      return () => {
        clearTimeout(clearTimer);
        clearTimeout(refreshTimer);
        clearTimeout(successTimer);
      };
    }
  }, [promptRefreshed, onClearConversations]);

  // Load available models on mount
  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        // Get models compatible with Chat shell type
        const response = await modelApis.getUnifiedModels('Chat');
        setAvailableModels(response.data || []);

        // If no model is selected and we have models, select the first one
        if (!selectedModel && response.data && response.data.length > 0) {
          const firstModel = response.data[0];
          onModelChange({
            model_name: firstModel.name,
            model_id: firstModel.modelId || undefined,
            reason: '',
            confidence: 1.0,
          });
        }
      } catch (error) {
        console.error('Failed to load models:', error);
      } finally {
        setIsLoadingModels(false);
      }
    };
    loadModels();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle click outside to close iterate panel
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (iteratePanelRef.current && !iteratePanelRef.current.contains(event.target as Node)) {
        setShowIteratePanel(false);
      }
    };

    if (showIteratePanel) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showIteratePanel]);

  if (isLoading) {
    return <GeneratingLoader />;
  }

  const handleTestSubmit = async () => {
    if (!testMessage.trim()) return;
    await onTestPrompt(testMessage);
    setTestMessage('');
  };

  const handleIterateSubmit = async () => {
    if (!feedbackMessage.trim()) return;
    await onIteratePrompt(feedbackMessage);
    setFeedbackMessage('');
  };

  const handleModelSelect = (modelName: string) => {
    const model = availableModels.find(m => m.name === modelName);
    if (model) {
      onModelChange({
        model_name: model.name,
        model_id: model.modelId || undefined,
        reason: '',
        confidence: 1.0,
      });
    }
  };

  // Get the latest conversation for single-round preview
  const latestConversation =
    testConversations.length > 0 ? testConversations[testConversations.length - 1] : null;

  // Convert test conversation to Message format for MessageBubble
  const convertToMessages = (conversation: TestConversation): Message[] => {
    const messages: Message[] = [];

    // User message
    messages.push({
      type: 'user',
      content: conversation.testMessage,
      timestamp: Date.now(),
    });

    // AI response (if available)
    if (conversation.modelResponse || isTestingPrompt) {
      messages.push({
        type: 'ai',
        content: conversation.modelResponse || '',
        timestamp: Date.now(),
        botName: selectedModel?.model_name || 'AI',
        isWaiting: isTestingPrompt && !conversation.modelResponse,
      });
    }

    return messages;
  };

  return (
    <div>
      {/* Main content - Left/Right split layout with independent scrolling */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-[480px]">
        {/* Left side - Model selector + Current prompt */}
        <div className="flex flex-col gap-4 h-full overflow-hidden">
          {/* Model selector */}
          <div className="space-y-2 flex-shrink-0">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Cpu className="w-4 h-4 text-text-secondary" />
              {t('wizard.select_model')}
            </Label>
            <Select
              value={selectedModel?.model_name || ''}
              onValueChange={handleModelSelect}
              disabled={isLoadingModels}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={isLoadingModels ? t('models.loading') : t('wizard.select_model')}
                />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map(model => (
                  <SelectItem key={model.name} value={model.name}>
                    <div className="flex items-center gap-2">
                      <span>{model.displayName || model.name}</span>
                      {model.type === 'public' && (
                        <span className="text-xs text-text-muted bg-muted px-1.5 py-0.5 rounded">
                          {t('models.public')}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
                {availableModels.length === 0 && !isLoadingModels && (
                  <div className="px-2 py-4 text-center text-sm text-text-muted">
                    {t('wizard.no_models_available')}
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Current prompt display/edit */}
          <div
            className={`flex-1 flex flex-col space-y-2 min-h-0 ${isRefreshing ? 'prompt-refresh-glow prompt-refresh-sparkle' : ''}`}
          >
            <div className="flex items-center justify-between flex-shrink-0">
              <Label className="text-sm font-medium flex items-center gap-2">
                <FileText className="w-4 h-4 text-text-secondary" />
                {t('wizard.system_prompt')}
                {showRefreshSuccess && (
                  <span className="flex items-center gap-1 text-xs text-primary refresh-toast">
                    <Sparkles className="w-3 h-3 refresh-success-icon" />
                    {t('wizard.prompt_refreshed')}
                  </span>
                )}
              </Label>
              {/* Trigger button with dropdown panel */}
              <div className="relative" ref={iteratePanelRef}>
                <Button
                  variant={showIteratePanel ? 'default' : 'outline'}
                  size="sm"
                  className="gap-1.5 h-7"
                  onClick={() => setShowIteratePanel(!showIteratePanel)}
                >
                  <Wand2 className="w-3.5 h-3.5 text-primary" />
                  {t('wizard.iterate_label')}
                </Button>
                {/* Dropdown panel - appears below the button */}
                {showIteratePanel && (
                  <div className="absolute top-full right-0 mt-2 z-50 w-[360px] bg-base border-2 border-primary/30 rounded-lg shadow-xl animate-fade-in overflow-hidden">
                    {/* Header with gradient background */}
                    <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-4 py-3 border-b border-primary/20">
                      <div className="flex items-center gap-2">
                        <Wand2 className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium text-text-primary">
                          {t('wizard.iterate_label')}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted mt-1">
                        {t('wizard.preview_adjust_iterate_hint')}
                      </p>
                    </div>
                    {/* Content area */}
                    <div className="p-4 space-y-3">
                      <Textarea
                        value={feedbackMessage}
                        onChange={e => setFeedbackMessage(e.target.value)}
                        placeholder={t('wizard.iterate_placeholder')}
                        className="min-h-[80px] text-sm border-border focus:border-primary/50"
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleIterateSubmit();
                          }
                        }}
                      />
                      <div className="flex justify-end">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleIterateSubmit}
                          disabled={isIteratingPrompt || !feedbackMessage.trim()}
                        >
                          {isIteratingPrompt ? (
                            <Spinner className="w-4 h-4" />
                          ) : (
                            <>
                              <RefreshCw className="w-4 h-4 mr-1" />
                              {t('wizard.iterate_button')}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-text-muted flex-shrink-0">
              {t('wizard.system_prompt_hint')}
            </p>
            <Textarea
              value={systemPrompt}
              onChange={e => onPromptChange(e.target.value)}
              className={`flex-1 min-h-0 font-mono text-sm resize-none transition-all duration-300 ${isRefreshing ? 'prompt-refreshing prompt-refresh-border' : ''}`}
              placeholder={t('wizard.system_prompt_placeholder')}
            />
          </div>
        </div>

        {/* Right side - Preview conversation */}
        <div className="flex flex-col gap-3 h-full overflow-hidden">
          {/* Single round hint */}
          <div className="flex items-center justify-between flex-shrink-0">
            <Label className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-text-secondary" />
              {t('wizard.single_round_preview')}
            </Label>
            <div className="flex items-center gap-2">
              {showRefreshSuccess && (
                <span className="text-xs text-primary flex items-center gap-1 refresh-toast">
                  <Sparkles className="w-3 h-3" />
                  {t('wizard.preview_cleared')}
                </span>
              )}
              <span className="text-xs text-text-muted bg-muted px-2 py-1 rounded">
                {t('wizard.single_round_hint')}
              </span>
            </div>
          </div>

          {/* Conversation preview area */}
          <div
            className={`flex-1 border rounded-lg bg-surface overflow-hidden flex flex-col min-h-0 transition-all duration-300 ${isRefreshing ? 'border-primary prompt-refresh-glow' : 'border-border'}`}
          >
            {/* Messages area */}
            <div
              className={`flex-1 p-4 ${latestConversation ? 'overflow-y-auto' : 'overflow-hidden'}`}
            >
              {!latestConversation ? (
                <div
                  className={`flex flex-col items-center justify-center h-full text-text-muted ${showRefreshSuccess && !latestConversation ? 'animate-fade-in' : ''}`}
                >
                  {showRefreshSuccess ? (
                    <>
                      <Sparkles className="w-10 h-10 mb-3 text-primary opacity-70 refresh-success-icon" />
                      <p className="text-sm text-primary">{t('wizard.prompt_optimized')}</p>
                      <p className="text-xs mt-1">{t('wizard.try_new_prompt')}</p>
                    </>
                  ) : (
                    <>
                      <MessageSquare className="w-10 h-10 mb-3 opacity-50" />
                      <p className="text-sm">{t('wizard.test_empty')}</p>
                      <p className="text-xs mt-1">{t('wizard.preview_adjust_empty_hint')}</p>
                    </>
                  )}
                </div>
              ) : (
                <div className={`space-y-4 ${isRefreshing ? 'messages-fade-out' : ''}`}>
                  {convertToMessages(latestConversation).map((msg, index) => (
                    <MessageBubble
                      key={`${msg.type}-${index}`}
                      msg={msg}
                      index={index}
                      selectedTaskDetail={null}
                      theme={theme}
                      t={t}
                      isWaiting={msg.isWaiting}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Test input area - fixed at bottom */}
            <div className="border-t border-border p-3 bg-base">
              <div className="flex gap-2">
                <Textarea
                  value={testMessage}
                  onChange={e => setTestMessage(e.target.value)}
                  placeholder={t('wizard.preview_adjust_input_placeholder')}
                  className="min-h-[50px] max-h-[80px] flex-1 text-sm resize-none"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleTestSubmit();
                    }
                  }}
                />
                <Button
                  variant="primary"
                  onClick={handleTestSubmit}
                  disabled={isTestingPrompt || !testMessage.trim() || !selectedModel}
                  className="self-end"
                  size="icon"
                >
                  {isTestingPrompt ? <Spinner className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
