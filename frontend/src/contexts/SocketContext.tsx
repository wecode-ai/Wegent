// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Socket.IO Context Provider
 *
 * Manages Socket.IO connection at the application level.
 * Provides connection state and socket instance to child components.
 * Auto-connects when user is authenticated.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { getToken } from '@/apis/user';
import {
  ServerEvents,
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatMessagePayload,
  ChatSendPayload,
  ChatSendAck,
  TaskCreatedPayload,
  TaskStatusPayload,
  TaskInvitedPayload,
} from '@/types/socket';

import { fetchRuntimeConfig, getSocketUrl } from '@/lib/runtime-config';

const SOCKETIO_PATH = '/socket.io';

interface SocketContextType {
  /** Socket.IO instance */
  socket: Socket | null;
  /** Whether connected to server */
  isConnected: boolean;
  /** Connection error if any */
  connectionError: Error | null;
  /** Reconnect attempt count */
  reconnectAttempts: number;
  /** Connect to Socket.IO server */
  connect: (token: string) => void;
  /** Disconnect from server */
  disconnect: () => void;
  /** Join a task room */
  joinTask: (taskId: number) => Promise<{
    streaming?: {
      subtask_id: number;
      offset: number;
      cached_content: string;
    };
    error?: string;
  }>;
  /** Leave a task room */
  leaveTask: (taskId: number) => void;
  /** Send a chat message via WebSocket */
  sendChatMessage: (payload: ChatSendPayload) => Promise<ChatSendAck>;
  /** Cancel a chat stream via WebSocket */
  cancelChatStream: (
    subtaskId: number,
    partialContent?: string,
    shellType?: string
  ) => Promise<{ success: boolean; error?: string }>;
  /** Retry a failed message via WebSocket */
  retryMessage: (
    taskId: number,
    subtaskId: number,
    modelId?: string,
    modelType?: string,
    forceOverride?: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  /** Register chat event handlers */
  registerChatHandlers: (handlers: ChatEventHandlers) => () => void;
  /** Register task event handlers */
  registerTaskHandlers: (handlers: TaskEventHandlers) => () => void;
}

/** Chat event handlers for streaming */
export interface ChatEventHandlers {
  onChatStart?: (data: ChatStartPayload) => void;
  onChatChunk?: (data: ChatChunkPayload) => void;
  onChatDone?: (data: ChatDonePayload) => void;
  onChatError?: (data: ChatErrorPayload) => void;
  onChatCancelled?: (data: ChatCancelledPayload) => void;
  /** Handler for chat:message event (other users' messages in group chat) */
  onChatMessage?: (data: ChatMessagePayload) => void;
}

/** Task event handlers for task list updates */
export interface TaskEventHandlers {
  onTaskCreated?: (data: TaskCreatedPayload) => void;
  onTaskInvited?: (data: TaskInvitedPayload) => void;
  onTaskStatus?: (data: TaskStatusPayload) => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  // Track current joined tasks
  const joinedTasksRef = useRef<Set<number>>(new Set());
  // Use ref for socket to avoid dependency issues in connect callback
  const socketRef = useRef<Socket | null>(null);

  /**
   * Internal function to create socket connection
   */
  const createSocketConnection = useCallback((token: string, socketUrl: string) => {
    console.log('[Socket.IO] Connecting to server...', socketUrl + '/chat');

    // Create new socket connection
    // Transport strategy:
    // 1. Try WebSocket first (preferred for load-balanced environments without sticky sessions)
    // 2. If WebSocket fails (e.g., load balancer doesn't support it), fall back to polling
    // Note: Polling requires sticky sessions in load-balanced environments
    const newSocket = io(socketUrl + '/chat', {
      path: SOCKETIO_PATH,
      auth: { token },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // Try websocket first, then fall back to polling if websocket fails
      // This handles cases where load balancer doesn't support WebSocket upgrade
      transports: ['websocket', 'polling'],
      // Increase timeout for mobile networks which may have higher latency
      timeout: 20000,
      // Force new connection to avoid stale connections on mobile
      forceNew: false,
      // Disable automatic upgrade from polling to websocket
      // This prevents "Invalid transport" errors when switching transports
      upgrade: true,
    });

    // Store in ref immediately
    socketRef.current = newSocket;

    // Connection event handlers
    newSocket.on('connect', () => {
      console.log('[Socket.IO] Connected:', newSocket.id);
      setIsConnected(true);
      setConnectionError(null);
      setReconnectAttempts(0);
    });

    newSocket.on('disconnect', (reason: string) => {
      console.log('[Socket.IO] Disconnected:', reason);
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error: Error) => {
      console.error('[Socket.IO] Connection error:', error);
      setConnectionError(error);
      setIsConnected(false);
    });

    newSocket.io.on('reconnect_attempt', (attempt: number) => {
      console.log('[Socket.IO] Reconnect attempt:', attempt);
      setReconnectAttempts(attempt);
    });

    newSocket.io.on('reconnect', (attempt: number) => {
      console.log('[Socket.IO] Reconnected after', attempt, 'attempts');
      setIsConnected(true);
      setConnectionError(null);
      setReconnectAttempts(0);

      // Rejoin all previously joined task rooms
      joinedTasksRef.current.forEach(taskId => {
        newSocket.emit('task:join', { task_id: taskId });
      });
    });

    newSocket.io.on('reconnect_error', (error: Error) => {
      console.error('[Socket.IO] Reconnect error:', error);
      setConnectionError(error);
    });

    setSocket(newSocket);
  }, []); // No dependencies - use refs instead

  /**
   * Connect to Socket.IO server
   * Fetches runtime config first to allow runtime URL changes
   */
  const connect = useCallback(
    (token: string) => {
      // Check if already connected using ref
      if (socketRef.current?.connected) {
        console.log('[Socket.IO] Already connected, skipping');
        return;
      }

      // Disconnect existing socket if any
      if (socketRef.current) {
        console.log('[Socket.IO] Disconnecting existing socket');
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      // Fetch runtime config then connect
      // This allows RUNTIME_SOCKET_DIRECT_URL to be changed without rebuilding
      fetchRuntimeConfig().then(config => {
        const socketUrl = config.socketDirectUrl || getSocketUrl();
        createSocketConnection(token, socketUrl);
      });
    },
    [createSocketConnection]
  );

  /**
   * Disconnect from server
   */
  const disconnect = useCallback(() => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
      setIsConnected(false);
      joinedTasksRef.current.clear();
    }
  }, [socket]);

  /**
   * Join a task room
   * Prevents duplicate joins by checking if already joined
   */
  const joinTask = useCallback(
    async (
      taskId: number
    ): Promise<{
      streaming?: {
        subtask_id: number;
        offset: number;
        cached_content: string;
      };
      error?: string;
    }> => {
      if (!socket?.connected) {
        return { error: 'Not connected' };
      }

      // Check if already joined this task room to prevent duplicate joins
      // This check happens BEFORE adding to the set to handle concurrent calls
      if (joinedTasksRef.current.has(taskId)) {
        console.log('[Socket.IO] Already joined task room, skipping:', taskId);
        return {};
      }

      // Add to set IMMEDIATELY to prevent concurrent duplicate joins
      // This is crucial because the socket.emit is async and multiple calls
      // could pass the above check before any callback completes
      joinedTasksRef.current.add(taskId);

      return new Promise(resolve => {
        socket.emit(
          'task:join',
          { task_id: taskId },
          (response: {
            streaming?: {
              subtask_id: number;
              offset: number;
              cached_content: string;
            };
            error?: string;
          }) => {
            // If there was an error, remove from the set so it can be retried
            if (response.error) {
              joinedTasksRef.current.delete(taskId);
            }
            resolve(response);
          }
        );
      });
    },
    [socket]
  );

  /**
   * Leave a task room
   */
  const leaveTask = useCallback(
    (taskId: number) => {
      if (socket?.connected) {
        socket.emit('task:leave', { task_id: taskId });
        joinedTasksRef.current.delete(taskId);
      }
    },
    [socket]
  );

  /**
   * Send a chat message via WebSocket
   */
  const sendChatMessage = useCallback(
    async (payload: ChatSendPayload): Promise<ChatSendAck> => {
      // Use socketRef for reliable access (socket state may be stale)
      const currentSocket = socketRef.current;

      console.log('[Socket.IO] sendChatMessage called', {
        hasSocket: !!currentSocket,
        isConnected: currentSocket?.connected,
        socketId: currentSocket?.id,
        payload: { ...payload, message: payload.message?.substring(0, 50) + '...' },
      });

      if (!currentSocket?.connected) {
        console.error('[Socket.IO] sendChatMessage failed: not connected', {
          hasSocket: !!currentSocket,
          isConnected: currentSocket?.connected,
        });
        return { error: 'Not connected to server' };
      }

      return new Promise(resolve => {
        console.log('[Socket.IO] Emitting chat:send event, payload:', {
          ...payload,
          attachment_ids: payload.attachment_ids,
          attachment_ids_length: payload.attachment_ids?.length || 0,
        });
        currentSocket.emit('chat:send', payload, (response: ChatSendAck) => {
          console.log('[Socket.IO] chat:send response received', response);
          resolve(response);
        });
      });
    },
    [] // No dependencies - use socketRef
  );

  /**
   * Cancel a chat stream via WebSocket
   */
  const cancelChatStream = useCallback(
    async (
      subtaskId: number,
      partialContent?: string,
      shellType?: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!socket?.connected) {
        console.error('[Socket.IO] cancelChatStream failed - not connected');
        return { success: false, error: 'Not connected to server' };
      }

      return new Promise(resolve => {
        socket.emit(
          'chat:cancel',
          {
            subtask_id: subtaskId,
            partial_content: partialContent,
            shell_type: shellType,
          },
          (response: { success?: boolean; error?: string }) => {
            resolve({ success: response.success ?? true, error: response.error });
          }
        );
      });
    },
    [socket]
  );

  /**
   * Retry a failed message via WebSocket
   */
  const retryMessage = useCallback(
    async (
      taskId: number,
      subtaskId: number,
      modelId?: string,
      modelType?: string,
      forceOverride: boolean = false
    ): Promise<{ success: boolean; error?: string }> => {
      if (!socket?.connected) {
        console.error('[Socket.IO] retryMessage failed - not connected');
        return { success: false, error: 'Not connected to server' };
      }

      const payload = {
        task_id: taskId,
        subtask_id: subtaskId,
        force_override_bot_model: modelId,
        force_override_bot_model_type: modelType,
        use_model_override: forceOverride,
      };

      console.log('[Socket.IO] Emitting chat:retry event', {
        taskId,
        subtaskId,
        modelId,
        modelType,
        forceOverride,
      });

      return new Promise(resolve => {
        socket.emit(
          'chat:retry',
          payload,
          (response: { success?: boolean; error?: string } | undefined) => {
            console.log('[Socket.IO] chat:retry response:', response);

            // Handle undefined response (backend error or no acknowledgment)
            if (!response) {
              console.error('[Socket.IO] chat:retry received undefined response');
              resolve({
                success: false,
                error: 'No response from server',
              });
              return;
            }

            resolve({
              success: response.success ?? false,
              error: response.error,
            });
          }
        );
      });
    },
    [socket]
  );

  /**
   * Register chat event handlers
   * Returns a cleanup function to unregister handlers
   */
  const registerChatHandlers = useCallback(
    (handlers: ChatEventHandlers): (() => void) => {
      if (!socket) {
        return () => {};
      }

      const { onChatStart, onChatChunk, onChatDone, onChatError, onChatCancelled, onChatMessage } =
        handlers;

      if (onChatStart) socket.on(ServerEvents.CHAT_START, onChatStart);
      if (onChatChunk) socket.on(ServerEvents.CHAT_CHUNK, onChatChunk);
      if (onChatDone) socket.on(ServerEvents.CHAT_DONE, onChatDone);
      if (onChatError) socket.on(ServerEvents.CHAT_ERROR, onChatError);
      if (onChatCancelled) socket.on(ServerEvents.CHAT_CANCELLED, onChatCancelled);
      if (onChatMessage) socket.on(ServerEvents.CHAT_MESSAGE, onChatMessage);

      // Return cleanup function
      return () => {
        if (onChatStart) socket.off(ServerEvents.CHAT_START, onChatStart);
        if (onChatChunk) socket.off(ServerEvents.CHAT_CHUNK, onChatChunk);
        if (onChatDone) socket.off(ServerEvents.CHAT_DONE, onChatDone);
        if (onChatError) socket.off(ServerEvents.CHAT_ERROR, onChatError);
        if (onChatCancelled) socket.off(ServerEvents.CHAT_CANCELLED, onChatCancelled);
        if (onChatMessage) socket.off(ServerEvents.CHAT_MESSAGE, onChatMessage);
      };
    },
    [socket]
  );

  /**
   * Register task event handlers for task list updates
   * Returns a cleanup function to unregister handlers
   */
  const registerTaskHandlers = useCallback(
    (handlers: TaskEventHandlers): (() => void) => {
      if (!socket) {
        return () => {};
      }

      const { onTaskCreated, onTaskInvited, onTaskStatus } = handlers;

      if (onTaskCreated) socket.on(ServerEvents.TASK_CREATED, onTaskCreated);
      if (onTaskInvited) socket.on(ServerEvents.TASK_INVITED, onTaskInvited);
      if (onTaskStatus) socket.on(ServerEvents.TASK_STATUS, onTaskStatus);

      // Return cleanup function
      return () => {
        if (onTaskCreated) socket.off(ServerEvents.TASK_CREATED, onTaskCreated);
        if (onTaskInvited) socket.off(ServerEvents.TASK_INVITED, onTaskInvited);
        if (onTaskStatus) socket.off(ServerEvents.TASK_STATUS, onTaskStatus);
      };
    },
    [socket]
  );

  // Auto-connect when component mounts if token is available
  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') {
      return;
    }

    // Check if already connected
    if (socketRef.current?.connected) {
      return;
    }

    const token = getToken();
    if (token) {
      console.log('[Socket.IO] Auto-connecting with token from localStorage');
      connect(token);
    } else {
      console.log('[Socket.IO] No token found, skipping auto-connect');
    }
  }, [connect]);

  // Listen for token changes (login/logout) - works across tabs
  // Also poll for token changes in current tab since storage event doesn't fire for same-tab changes
  useEffect(() => {
    // Handle cross-tab storage changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'auth_token') {
        if (e.newValue) {
          // Token was set (login from another tab)
          console.log('[Socket.IO] Token changed in another tab, connecting');
          connect(e.newValue);
        } else {
          // Token was removed (logout from another tab)
          console.log('[Socket.IO] Token removed in another tab, disconnecting');
          disconnect();
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [connect, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, [socket]);

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        connectionError,
        reconnectAttempts,
        connect,
        disconnect,
        joinTask,
        leaveTask,
        sendChatMessage,
        cancelChatStream,
        retryMessage,
        registerChatHandlers,
        registerTaskHandlers,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

/**
 * Hook to use socket context
 */
export function useSocket(): SocketContextType {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}

/**
 * Hook to auto-connect socket when token is available
 * @deprecated Socket now auto-connects in SocketProvider
 */
export function useSocketAutoConnect(token: string | null) {
  const { connect, disconnect: _disconnect, isConnected } = useSocket();

  useEffect(() => {
    if (token && !isConnected) {
      connect(token);
    }
    return () => {
      // Don't disconnect on cleanup - let the provider manage lifecycle
    };
  }, [token, connect, isConnected]);
}
