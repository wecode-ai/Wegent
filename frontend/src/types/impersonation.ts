// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Impersonation Types

export type ImpersonationStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'used';

// Impersonation Request
export interface ImpersonationRequest {
  id: number;
  admin_user_id: number;
  admin_user_name: string;
  target_user_id: number;
  target_user_name: string;
  token: string;
  status: ImpersonationStatus;
  confirmation_url: string;
  expires_at: string;
  approved_at: string | null;
  session_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImpersonationRequestListResponse {
  total: number;
  items: ImpersonationRequest[];
}

export interface ImpersonationRequestCreate {
  target_user_id: number;
}

// Impersonation Confirmation
export interface ImpersonationConfirmInfo {
  id: number;
  admin_user_name: string;
  target_user_name: string;
  status: ImpersonationStatus;
  expires_at: string;
  remaining_seconds: number;
  created_at: string;
}

// Impersonation Session
export interface ImpersonationStartResponse {
  access_token: string;
  token_type: string;
  impersonated_user_id: number;
  impersonated_user_name: string;
  session_expires_at: string;
}

export interface ImpersonationExitResponse {
  access_token: string;
  token_type: string;
  message: string;
}

// Audit Logs
export interface ImpersonationAuditLog {
  id: number;
  impersonation_request_id: number;
  admin_user_id: number;
  admin_user_name: string;
  target_user_id: number;
  target_user_name: string;
  action: string;
  method: string;
  path: string;
  request_body: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface ImpersonationAuditLogListResponse {
  total: number;
  items: ImpersonationAuditLog[];
}

// Impersonation Info (from JWT token)
export interface ImpersonationInfo {
  isImpersonating: boolean;
  impersonatorId?: number;
  impersonatorName?: string;
  impersonationRequestId?: number;
  impersonationExpiresAt?: Date;
}
