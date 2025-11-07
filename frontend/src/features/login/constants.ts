// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const POST_LOGIN_REDIRECT_KEY = 'postLoginRedirectPath'

export const sanitizeRedirectPath = (
  candidate: string | null | undefined,
  disallow: string[] = []
) => {
  if (!candidate) return null
  if (!candidate.startsWith('/')) return null
  if (candidate.startsWith('//')) return null
  if (disallow.includes(candidate)) return null
  return candidate
}
