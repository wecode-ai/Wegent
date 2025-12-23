// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { SelectedModel } from '../components/MultiModelSelector';

// Model response state
export interface ModelResponseState {
  subtaskId: number;
  modelName: string;
  modelDisplayName: string;
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  error?: string;
  isSelected: boolean;
}

// Comparison group state
export interface CompareGroupState {
  compareGroupId: string;
  taskId: number;
  messageId?: number;
  userMessage: string;
  responses: Map<string, ModelResponseState>; // modelName -> state
  allDone: boolean;
  selectedModelName?: string;
}

// Context state
interface CompareContextState {
  // Compare mode settings
  compareMode: boolean;
  selectedModels: SelectedModel[];

  // Active comparison
  activeCompareGroup: CompareGroupState | null;

  // History of comparisons (for viewing collapsed responses)
  compareHistory: Map<string, CompareGroupState>;
}

// Context actions
interface CompareContextActions {
  // Mode management
  setCompareMode: (enabled: boolean) => void;
  setSelectedModels: (models: SelectedModel[]) => void;

  // Comparison lifecycle
  startComparison: (
    compareGroupId: string,
    taskId: number,
    userMessage: string,
    models: Array<{ modelName: string; modelDisplayName: string; subtaskId: number }>
  ) => void;

  // Stream updates
  updateModelChunk: (
    compareGroupId: string,
    modelName: string,
    content: string,
    offset: number
  ) => void;

  markModelDone: (
    compareGroupId: string,
    modelName: string,
    result: Record<string, unknown>
  ) => void;

  markModelError: (compareGroupId: string, modelName: string, error: string) => void;

  markAllDone: (compareGroupId: string, messageId?: number) => void;

  // Selection
  selectResponse: (compareGroupId: string, modelName: string) => void;

  // Cleanup
  clearActiveComparison: () => void;
  clearAll: () => void;
}

type CompareContextType = CompareContextState & CompareContextActions;

const CompareContext = createContext<CompareContextType | null>(null);

export function useCompareContext() {
  const context = useContext(CompareContext);
  if (!context) {
    throw new Error('useCompareContext must be used within CompareProvider');
  }
  return context;
}

interface CompareProviderProps {
  children: ReactNode;
}

export function CompareProvider({ children }: CompareProviderProps) {
  const [compareMode, setCompareModeState] = useState(false);
  const [selectedModels, setSelectedModelsState] = useState<SelectedModel[]>([]);
  const [activeCompareGroup, setActiveCompareGroup] = useState<CompareGroupState | null>(null);
  const [compareHistory, setCompareHistory] = useState<Map<string, CompareGroupState>>(new Map());

  // Mode management
  const setCompareMode = useCallback((enabled: boolean) => {
    setCompareModeState(enabled);
    if (!enabled) {
      setSelectedModelsState(prev => (prev.length > 1 ? [prev[0]] : prev));
    }
  }, []);

  const setSelectedModels = useCallback((models: SelectedModel[]) => {
    setSelectedModelsState(models);
  }, []);

  // Start a new comparison
  const startComparison = useCallback(
    (
      compareGroupId: string,
      taskId: number,
      userMessage: string,
      models: Array<{
        modelName: string;
        modelDisplayName: string;
        subtaskId: number;
      }>
    ) => {
      const responses = new Map<string, ModelResponseState>();
      models.forEach(model => {
        responses.set(model.modelName, {
          subtaskId: model.subtaskId,
          modelName: model.modelName,
          modelDisplayName: model.modelDisplayName,
          content: '',
          status: 'pending',
          isSelected: false,
        });
      });

      const newGroup: CompareGroupState = {
        compareGroupId,
        taskId,
        userMessage,
        responses,
        allDone: false,
      };

      setActiveCompareGroup(newGroup);
    },
    []
  );

  // Update chunk for a model
  const updateModelChunk = useCallback(
    (compareGroupId: string, modelName: string, content: string, _offset: number) => {
      setActiveCompareGroup(prev => {
        if (!prev || prev.compareGroupId !== compareGroupId) return prev;

        const responses = new Map(prev.responses);
        const modelState = responses.get(modelName);
        if (modelState) {
          responses.set(modelName, {
            ...modelState,
            content: modelState.content + content,
            status: 'streaming',
          });
        }

        return { ...prev, responses };
      });
    },
    []
  );

  // Mark a model as done
  const markModelDone = useCallback(
    (compareGroupId: string, modelName: string, result: Record<string, unknown>) => {
      setActiveCompareGroup(prev => {
        if (!prev || prev.compareGroupId !== compareGroupId) return prev;

        const responses = new Map(prev.responses);
        const modelState = responses.get(modelName);
        if (modelState) {
          const finalContent = typeof result.value === 'string' ? result.value : modelState.content;
          responses.set(modelName, {
            ...modelState,
            content: finalContent,
            status: 'completed',
          });
        }

        return { ...prev, responses };
      });
    },
    []
  );

  // Mark a model as error
  const markModelError = useCallback((compareGroupId: string, modelName: string, error: string) => {
    setActiveCompareGroup(prev => {
      if (!prev || prev.compareGroupId !== compareGroupId) return prev;

      const responses = new Map(prev.responses);
      const modelState = responses.get(modelName);
      if (modelState) {
        responses.set(modelName, {
          ...modelState,
          status: 'error',
          error,
        });
      }

      return { ...prev, responses };
    });
  }, []);

  // Mark all models as done
  const markAllDone = useCallback((compareGroupId: string, messageId?: number) => {
    setActiveCompareGroup(prev => {
      if (!prev || prev.compareGroupId !== compareGroupId) return prev;

      return { ...prev, allDone: true, messageId };
    });
  }, []);

  // Select a response
  const selectResponse = useCallback((compareGroupId: string, modelName: string) => {
    setActiveCompareGroup(prev => {
      if (!prev || prev.compareGroupId !== compareGroupId) return prev;

      const responses = new Map(prev.responses);
      responses.forEach((state, key) => {
        responses.set(key, {
          ...state,
          isSelected: key === modelName,
        });
      });

      return { ...prev, responses, selectedModelName: modelName };
    });

    // Move to history after selection
    setActiveCompareGroup(current => {
      if (current && current.compareGroupId === compareGroupId) {
        setCompareHistory(prev => {
          const updated = new Map(prev);
          updated.set(compareGroupId, current);
          return updated;
        });
      }
      return null;
    });
  }, []);

  // Clear active comparison
  const clearActiveComparison = useCallback(() => {
    setActiveCompareGroup(null);
  }, []);

  // Clear all
  const clearAll = useCallback(() => {
    setActiveCompareGroup(null);
    setCompareHistory(new Map());
  }, []);

  const value: CompareContextType = {
    // State
    compareMode,
    selectedModels,
    activeCompareGroup,
    compareHistory,

    // Actions
    setCompareMode,
    setSelectedModels,
    startComparison,
    updateModelChunk,
    markModelDone,
    markModelError,
    markAllDone,
    selectResponse,
    clearActiveComparison,
    clearAll,
  };

  return <CompareContext.Provider value={value}>{children}</CompareContext.Provider>;
}
