// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { SigningKey, TokenIssuer } from '@/apis/admin'

export type IssuerFormState = {
  name: string
  signingKeyId: string
  issuer: string
  audience: string
  defaultTtlSeconds: string
  maxTtlSeconds: string
  description: string
  enabled: boolean
}

export type InlineKeyFormState = {
  name: string
  description: string
}

export type DeleteTarget =
  | { type: 'issuer'; issuer: TokenIssuer }
  | { type: 'key'; key: SigningKey }

export type PemTarget = {
  title: string
  kid: string
  name: string
  publicKeyPem: string
}
