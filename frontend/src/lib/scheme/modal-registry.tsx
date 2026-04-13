// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ComponentType } from 'react'

export type ModalParams = Record<string, unknown>

export interface RegisteredModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  params?: ModalParams
}

export interface ModalRegistration {
  id: string
  component: ComponentType<RegisteredModalProps>
}

const modalRegistry = new Map<string, ModalRegistration>()

export function registerModal(registration: ModalRegistration): void {
  modalRegistry.set(registration.id, registration)
}

export function getRegisteredModal(id: string): ModalRegistration | undefined {
  return modalRegistry.get(id)
}
