// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getApiBaseUrl } from '@/lib/runtime-config'
import { getToken, removeToken } from '@/apis/user'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
import type {
  ExternalKbNodeListParams,
  ExternalKbNodeListResponse,
  ExternalKnowledgeBase,
  ExternalKnowledgeBaseListParams,
  ExternalKnowledgeBaseListResponse,
  ExternalKnowledgeHealth,
  ExternalKnowledgePreview,
  ExternalKnowledgeProvider,
  ExternalSearchResult,
} from '@wecode/types/external-knowledge'

const BASE_API_PREFIX = '/wecode/external-knowledge'

export class ExternalKnowledgeApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ExternalKnowledgeApiError'
    this.status = status
    this.code = code
  }
}

type ExternalKnowledgeErrorPayload = {
  detail?: string | { code?: string; message?: string; detail?: string }
  code?: string
  message?: string
}

function getExternalKnowledgeUrl(provider: ExternalKnowledgeProvider, path: string): string {
  return `${getApiBaseUrl()}${BASE_API_PREFIX}/${encodeURIComponent(provider)}${path}`
}

function appendQuery(url: string, params: object) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      value !== ''
    ) {
      searchParams.set(key, String(value))
    }
  })

  const query = searchParams.toString()
  return query ? `${url}?${query}` : url
}

function redirectToLogin() {
  removeToken()
  if (typeof window === 'undefined') return

  const loginPath = paths.auth.login.getHref()
  if (window.location.pathname === loginPath) {
    window.location.href = loginPath
    return
  }

  const disallowedTargets = [loginPath, '/login/oidc']
  const currentPathWithSearch = `${window.location.pathname}${window.location.search}`
  const redirectTarget = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets)
  if (redirectTarget) {
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTarget)
    window.location.href = `${loginPath}?redirect=${encodeURIComponent(redirectTarget)}`
  } else {
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
    window.location.href = loginPath
  }
}

function parseExternalKnowledgeError(error: ExternalKnowledgeErrorPayload) {
  const detail = error.detail
  const message =
    typeof detail === 'string'
      ? detail
      : detail?.message || detail?.detail || error.message || 'Request failed'
  const code = typeof detail === 'string' ? error.code : detail?.code || error.code

  return { message, code }
}

async function fetchExternalJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken()
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response
      .json()
      .catch((): ExternalKnowledgeErrorPayload => ({ detail: 'Request failed' }))
    const { message, code } = parseExternalKnowledgeError(error)

    if (response.status === 401 && !code) {
      redirectToLogin()
      throw new ExternalKnowledgeApiError('Authentication failed', response.status, 'unauthorized')
    }

    throw new ExternalKnowledgeApiError(message, response.status, code)
  }

  return response.json()
}

function normalizeListResponse<T>(data: T[] | { items?: T[]; results?: T[]; data?: T[] }) {
  if (Array.isArray(data)) {
    return { items: data }
  }

  return {
    ...data,
    items: data.items ?? data.results ?? data.data ?? [],
  }
}

export async function getExternalKnowledgeHealth(
  provider: ExternalKnowledgeProvider
): Promise<ExternalKnowledgeHealth> {
  return fetchExternalJson<ExternalKnowledgeHealth>(getExternalKnowledgeUrl(provider, '/health'))
}

export async function listExternalKnowledgeBases(
  provider: ExternalKnowledgeProvider,
  params: ExternalKnowledgeBaseListParams = {}
): Promise<ExternalKnowledgeBaseListResponse> {
  const url = appendQuery(getExternalKnowledgeUrl(provider, '/knowledge-bases'), params)
  const data = await fetchExternalJson<ExternalKnowledgeBase[] | ExternalKnowledgeBaseListResponse>(
    url
  )
  return normalizeListResponse(data)
}

export async function listExternalKnowledgeNodes(
  provider: ExternalKnowledgeProvider,
  kbId: string,
  params: ExternalKbNodeListParams = {}
): Promise<ExternalKbNodeListResponse> {
  const url = appendQuery(
    getExternalKnowledgeUrl(provider, `/knowledge-bases/${encodeURIComponent(kbId)}/nodes`),
    params
  )
  const data = await fetchExternalJson<
    ExternalKbNodeListResponse['items'] | ExternalKbNodeListResponse
  >(url)
  return normalizeListResponse(data)
}

export async function getExternalKnowledgePreview(
  provider: ExternalKnowledgeProvider,
  params: { kb_id: string; node_id?: string; document_id?: string; folder_id?: string | null }
): Promise<ExternalKnowledgePreview> {
  const url = appendQuery(getExternalKnowledgeUrl(provider, '/preview'), params)
  return fetchExternalJson<ExternalKnowledgePreview>(url)
}

export async function searchExternalKnowledge(
  provider: ExternalKnowledgeProvider,
  body: { query: string; knowledge_base_ids?: string[]; max_results?: number }
): Promise<ExternalSearchResult> {
  return fetchExternalJson<ExternalSearchResult>(getExternalKnowledgeUrl(provider, '/search'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
