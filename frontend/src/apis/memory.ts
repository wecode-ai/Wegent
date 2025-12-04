// SPDX-FileCopyrightText: 2025 WeCode-AI, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory API client for long-term memory management.
 *
 * This module provides API calls for managing user memories stored in mem0.
 */

import { getToken } from './user';

const API_BASE_URL = '/api';

/**
 * Memory item response
 */
export interface Memory {
  id: string;
  content: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Memory list response
 */
export interface MemoryListResponse {
  memories: Memory[];
  total: number;
}

/**
 * Memory service health status
 */
export interface MemoryHealthResponse {
  configured: boolean;
  healthy: boolean;
}

/**
 * Get all memories for the current user.
 *
 * @param keyword - Optional keyword to search/filter memories
 * @returns List of user's memories
 */
export async function getMemories(keyword?: string): Promise<MemoryListResponse> {
  const token = getToken();
  const params = new URLSearchParams();
  if (keyword) {
    params.set('keyword', keyword);
  }

  const url = `${API_BASE_URL}/memories${params.toString() ? `?${params.toString()}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Get a single memory by ID.
 *
 * @param memoryId - Memory ID
 * @returns Memory details
 */
export async function getMemory(memoryId: string): Promise<Memory> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/memories/${memoryId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Update a memory's content.
 *
 * @param memoryId - Memory ID
 * @param content - New content
 * @returns Updated memory
 */
export async function updateMemory(memoryId: string, content: string): Promise<Memory> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/memories/${memoryId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Delete a memory.
 *
 * @param memoryId - Memory ID
 * @returns Success response
 */
export async function deleteMemory(memoryId: string): Promise<{ success: boolean; message: string }> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/memories/${memoryId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Check memory service health status.
 *
 * @returns Service health status
 */
export async function checkMemoryHealth(): Promise<MemoryHealthResponse> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/memories/health/check`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    // If service is unavailable, return not configured
    return { configured: false, healthy: false };
  }

  return response.json();
}

/**
 * Memory API exports
 */
export const memoryApis = {
  getMemories,
  getMemory,
  updateMemory,
  deleteMemory,
  checkMemoryHealth,
};
