// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Enums
export type QueueVisibility = 'private' | 'public' | 'group_visible' | 'invite_only'
export type QueueMessageStatus = 'unread' | 'read' | 'processing' | 'processed' | 'archived'
export type QueueMessagePriority = 'low' | 'normal' | 'high'
export type TriggerMode = 'immediate' | 'manual' | 'scheduled' | 'condition_based'
export type ConditionType = 'priority_high' | 'specific_sender'
export type ConditionAction = 'immediate' | 'skip'

// Types
export interface TeamRef {
  namespace: string
  name: string
}

export interface ProcessCondition {
  type: ConditionType
  value?: string
  action: ConditionAction
}

export interface AutoProcessConfig {
  enabled: boolean
  teamRef?: TeamRef
  triggerMode: TriggerMode
  scheduleInterval?: number
  conditions?: ProcessCondition[]
}

export interface ResultFeedbackConfig {
  replyToSender: boolean
  saveInQueue: boolean
  sendNotification: boolean
}

export interface WorkQueue {
  id: number
  name: string
  displayName: string
  description?: string
  isDefault: boolean
  visibility: QueueVisibility
  visibleToGroups?: string[]
  inviteCode?: string
  autoProcess?: AutoProcessConfig
  resultFeedback?: ResultFeedbackConfig
  messageCount: number
  unreadCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkQueueListResponse {
  items: WorkQueue[]
  total: number
}

export interface WorkQueueCreateRequest {
  name: string
  displayName: string
  description?: string
  visibility?: QueueVisibility
  visibleToGroups?: string[]
  autoProcess?: AutoProcessConfig
  resultFeedback?: ResultFeedbackConfig
}

export interface WorkQueueUpdateRequest {
  displayName?: string
  description?: string
  visibility?: QueueVisibility
  visibleToGroups?: string[]
  autoProcess?: AutoProcessConfig
  resultFeedback?: ResultFeedbackConfig
}

// Queue Message Types
export interface SenderInfo {
  id: number
  userName: string
  email?: string
}

export interface MessageContentSnapshot {
  role: string
  content: string
  senderUserName?: string
  createdAt?: string
  attachments?: Array<{
    id: number
    context_type: string
    name: string
    status: string
    file_extension?: string
    file_size?: number
  }>
}

export interface QueueMessage {
  id: number
  queueId: number
  sender: SenderInfo
  sourceTaskId: number
  sourceSubtaskIds: number[]
  contentSnapshot: MessageContentSnapshot[]
  note?: string
  priority: QueueMessagePriority
  status: QueueMessageStatus
  processResult?: Record<string, unknown>
  processTaskId?: number
  createdAt: string
  updatedAt: string
  processedAt?: string
}

export interface QueueMessageListResponse {
  items: QueueMessage[]
  total: number
  unreadCount: number
}

export interface UnreadCountResponse {
  total: number
  byQueue: Record<number, number>
}

// Forward Message Types
export interface ForwardRecipient {
  type: 'user' | 'group'
  id: number
  queueId?: number
}

export interface ForwardMessageRequest {
  sourceTaskId: number
  subtaskIds?: number[]
  recipients: ForwardRecipient[]
  note?: string
  priority?: QueueMessagePriority
}

export interface ForwardMessageResponse {
  success: boolean
  forwardedCount: number
  failedRecipients?: Array<{
    type: string
    id: number
    error: string
  }>
}

// Public Queue Types
export interface PublicQueue {
  id: number
  name: string
  displayName: string
  description?: string
  isDefault: boolean
}

export interface UserPublicQueuesResponse {
  userId: number
  userName: string
  queues: PublicQueue[]
}

// Recent Contact Types
export interface RecentContact {
  id: number
  userId: number
  userName: string
  email?: string
  lastContactAt: string
  contactCount: number
}

export interface RecentContactsListResponse {
  items: RecentContact[]
  total: number
}

// API Functions

// Work Queue Management
export async function listWorkQueues(): Promise<WorkQueueListResponse> {
  return apiClient.get<WorkQueueListResponse>('/work-queues')
}

export async function getWorkQueue(queueId: number): Promise<WorkQueue> {
  return apiClient.get<WorkQueue>(`/work-queues/${queueId}`)
}

export async function createWorkQueue(data: WorkQueueCreateRequest): Promise<WorkQueue> {
  return apiClient.post<WorkQueue>('/work-queues', data)
}

export async function updateWorkQueue(
  queueId: number,
  data: WorkQueueUpdateRequest
): Promise<WorkQueue> {
  return apiClient.put<WorkQueue>(`/work-queues/${queueId}`, data)
}

export async function deleteWorkQueue(queueId: number): Promise<void> {
  return apiClient.delete(`/work-queues/${queueId}`)
}

export async function setDefaultQueue(queueId: number): Promise<WorkQueue> {
  return apiClient.post<WorkQueue>(`/work-queues/${queueId}/set-default`)
}

export async function regenerateInviteCode(queueId: number): Promise<WorkQueue> {
  return apiClient.post<WorkQueue>(`/work-queues/${queueId}/regenerate-invite`)
}

// Queue Messages
export async function listQueueMessages(
  queueId: number,
  params?: {
    status?: QueueMessageStatus
    priority?: QueueMessagePriority
    sender_user_id?: number
    skip?: number
    limit?: number
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  }
): Promise<QueueMessageListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.status) searchParams.append('status', params.status)
  if (params?.priority) searchParams.append('priority', params.priority)
  if (params?.sender_user_id) searchParams.append('sender_user_id', String(params.sender_user_id))
  if (params?.skip !== undefined) searchParams.append('skip', String(params.skip))
  if (params?.limit !== undefined) searchParams.append('limit', String(params.limit))
  if (params?.sort_by) searchParams.append('sort_by', params.sort_by)
  if (params?.sort_order) searchParams.append('sort_order', params.sort_order)

  const query = searchParams.toString()
  const url = `/work-queues/${queueId}/messages${query ? `?${query}` : ''}`
  return apiClient.get<QueueMessageListResponse>(url)
}

export async function getQueueMessage(messageId: number): Promise<QueueMessage> {
  return apiClient.get<QueueMessage>(`/queue-messages/${messageId}`)
}

export async function updateMessageStatus(
  messageId: number,
  status: QueueMessageStatus
): Promise<QueueMessage> {
  return apiClient.patch<QueueMessage>(`/queue-messages/${messageId}/status`, { status })
}

export async function updateMessagePriority(
  messageId: number,
  priority: QueueMessagePriority
): Promise<QueueMessage> {
  return apiClient.patch<QueueMessage>(`/queue-messages/${messageId}/priority`, { priority })
}

export async function deleteQueueMessage(messageId: number): Promise<void> {
  return apiClient.delete(`/queue-messages/${messageId}`)
}

export async function getUnreadMessageCount(): Promise<UnreadCountResponse> {
  return apiClient.get<UnreadCountResponse>('/work-queues/messages/unread-count')
}

// Message Forwarding
export async function forwardMessages(data: ForwardMessageRequest): Promise<ForwardMessageResponse> {
  return apiClient.post<ForwardMessageResponse>('/messages/forward', data)
}

// User Public Queues
export async function getUserPublicQueues(userId: number): Promise<UserPublicQueuesResponse> {
  return apiClient.get<UserPublicQueuesResponse>(`/users/${userId}/public-queues`)
}

// Recent Contacts
export async function getRecentContacts(limit?: number): Promise<RecentContactsListResponse> {
  const query = limit ? `?limit=${limit}` : ''
  return apiClient.get<RecentContactsListResponse>(`/users/recent-contacts${query}`)
}
