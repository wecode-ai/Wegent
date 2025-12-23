// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useCallback } from 'react';
import { useSocket } from '@/contexts/SocketContext';
import { useCompareContext } from '../contexts/compareContext';
import {
  ServerEvents,
  ClientEvents,
  ChatCompareStartPayload,
  ChatCompareChunkPayload,
  ChatCompareDonePayload,
  ChatCompareAllDonePayload,
  ChatCompareErrorPayload,
  ChatCompareSelectedPayload,
  ChatCompareSendPayload,
  ChatCompareSelectPayload,
  ChatCompareSendAck,
} from '@/types/socket';

interface UseCompareStreamOptions {
  taskId?: number;
  teamId?: number;
  onError?: (error: string) => void;
}

export function useCompareStream({ taskId, teamId, onError }: UseCompareStreamOptions) {
  const { socket, isConnected } = useSocket();
  const {
    compareMode,
    selectedModels,
    startComparison,
    updateModelChunk,
    markModelDone,
    markModelError,
    markAllDone,
    selectResponse,
    activeCompareGroup,
  } = useCompareContext();

  // Handle comparison start event
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareStart = (payload: ChatCompareStartPayload) => {
      console.log('[useCompareStream] chat:compare_start received', payload);
      startComparison(
        payload.compare_group_id,
        payload.task_id,
        '', // User message will be set separately
        payload.models.map(m => ({
          modelName: m.model_name,
          modelDisplayName: m.model_display_name,
          subtaskId: m.subtask_id,
        }))
      );
    };

    socket.on(ServerEvents.CHAT_COMPARE_START, handleCompareStart);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_START, handleCompareStart);
    };
  }, [socket, isConnected, startComparison]);

  // Handle comparison chunk event
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareChunk = (payload: ChatCompareChunkPayload) => {
      updateModelChunk(
        payload.compare_group_id,
        payload.model_name,
        payload.content,
        payload.offset
      );
    };

    socket.on(ServerEvents.CHAT_COMPARE_CHUNK, handleCompareChunk);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_CHUNK, handleCompareChunk);
    };
  }, [socket, isConnected, updateModelChunk]);

  // Handle comparison done event (single model)
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareDone = (payload: ChatCompareDonePayload) => {
      console.log('[useCompareStream] chat:compare_done received', payload);
      markModelDone(payload.compare_group_id, payload.model_name, payload.result);
    };

    socket.on(ServerEvents.CHAT_COMPARE_DONE, handleCompareDone);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_DONE, handleCompareDone);
    };
  }, [socket, isConnected, markModelDone]);

  // Handle comparison all done event
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareAllDone = (payload: ChatCompareAllDonePayload) => {
      console.log('[useCompareStream] chat:compare_all_done received', payload);
      markAllDone(payload.compare_group_id, payload.message_id);
    };

    socket.on(ServerEvents.CHAT_COMPARE_ALL_DONE, handleCompareAllDone);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_ALL_DONE, handleCompareAllDone);
    };
  }, [socket, isConnected, markAllDone]);

  // Handle comparison error event
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareError = (payload: ChatCompareErrorPayload) => {
      console.error('[useCompareStream] chat:compare_error received', payload);
      markModelError(payload.compare_group_id, payload.model_name, payload.error);
      onError?.(payload.error);
    };

    socket.on(ServerEvents.CHAT_COMPARE_ERROR, handleCompareError);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_ERROR, handleCompareError);
    };
  }, [socket, isConnected, markModelError, onError]);

  // Handle comparison selected event (for other users in the room)
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleCompareSelected = (payload: ChatCompareSelectedPayload) => {
      console.log('[useCompareStream] chat:compare_selected received', payload);
      selectResponse(payload.compare_group_id, payload.model_name);
    };

    socket.on(ServerEvents.CHAT_COMPARE_SELECTED, handleCompareSelected);

    return () => {
      socket.off(ServerEvents.CHAT_COMPARE_SELECTED, handleCompareSelected);
    };
  }, [socket, isConnected, selectResponse]);

  // Send comparison request
  const sendCompareRequest = useCallback(
    async (
      message: string,
      options?: {
        title?: string;
        attachmentId?: number;
        enableWebSearch?: boolean;
        searchEngine?: string;
      }
    ): Promise<ChatCompareSendAck> => {
      if (!socket || !isConnected) {
        return { error: 'Not connected' };
      }

      if (!teamId) {
        return { error: 'Team ID is required' };
      }

      if (selectedModels.length < 2) {
        return { error: 'Select at least 2 models for comparison' };
      }

      const payload: ChatCompareSendPayload = {
        task_id: taskId,
        team_id: teamId,
        message,
        title: options?.title,
        models: selectedModels.map(m => ({
          name: m.name,
          display_name: m.displayName,
          type: m.type,
        })),
        attachment_id: options?.attachmentId,
        enable_web_search: options?.enableWebSearch,
        search_engine: options?.searchEngine,
      };

      return new Promise(resolve => {
        socket.emit(ClientEvents.CHAT_COMPARE_SEND, payload, (response: ChatCompareSendAck) => {
          console.log('[useCompareStream] chat:compare_send ack', response);
          if (response.error) {
            onError?.(response.error);
          }
          resolve(response);
        });
      });
    },
    [socket, isConnected, taskId, teamId, selectedModels, onError]
  );

  // Select response
  const selectCompareResponse = useCallback(
    async (
      compareGroupId: string,
      selectedSubtaskId: number
    ): Promise<{ success?: boolean; error?: string }> => {
      if (!socket || !isConnected) {
        return { error: 'Not connected' };
      }

      if (!taskId) {
        return { error: 'Task ID is required' };
      }

      const payload: ChatCompareSelectPayload = {
        task_id: taskId,
        compare_group_id: compareGroupId,
        selected_subtask_id: selectedSubtaskId,
      };

      return new Promise(resolve => {
        socket.emit(
          ClientEvents.CHAT_COMPARE_SELECT,
          payload,
          (response: { success?: boolean; error?: string }) => {
            console.log('[useCompareStream] chat:compare_select ack', response);
            resolve(response);
          }
        );
      });
    },
    [socket, isConnected, taskId]
  );

  return {
    compareMode,
    selectedModels,
    activeCompareGroup,
    sendCompareRequest,
    selectCompareResponse,
    isComparing: !!activeCompareGroup && !activeCompareGroup.allDone,
  };
}
