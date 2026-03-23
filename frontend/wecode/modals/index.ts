// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { getScheme } from '@/lib/scheme'
import { getRegisteredModal, registerModal } from '@/lib/scheme/modal-registry'
import { registerModalScheme } from '@/lib/scheme/modals'

import { HimalayaMailConfigDialog } from '@wecode/components/devices/HimalayaMailConfigDialog'

if (!getRegisteredModal('himalaya-mail-config')) {
  registerModal({
    id: 'himalaya-mail-config',
    component: HimalayaMailConfigDialog,
  })
}

if (!getScheme('modal-himalaya-mail-config')) {
  registerModalScheme({
    schemeId: 'modal-himalaya-mail-config',
    modalType: 'himalaya-mail-config',
    pattern: 'wegent://modal/himalaya-mail-config',
    description: 'Open Himalaya mail configuration dialog',
    examples: ['wegent://modal/himalaya-mail-config'],
  })
}
