// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { getScheme } from '@/lib/scheme'
import { getRegisteredModal, registerModal } from '@/lib/scheme/modal-registry'
import { registerModalScheme } from '@/lib/scheme/modals'

import { HimalayaAccessGuideDialog } from '@wecode/components/devices/HimalayaAccessGuideDialog'
import { HimalayaMailConfigDialog } from '@wecode/components/devices/HimalayaMailConfigDialog'

if (!getRegisteredModal('himalaya-access-guide')) {
  registerModal({
    id: 'himalaya-access-guide',
    component: HimalayaAccessGuideDialog,
  })
}

if (!getScheme('modal-himalaya-access-guide')) {
  registerModalScheme({
    schemeId: 'modal-himalaya-access-guide',
    modalType: 'himalaya-access-guide',
    pattern: 'wegent://modal/himalaya-access-guide',
    description: 'Open Himalaya device access guide dialog',
    examples: ['wegent://modal/himalaya-access-guide'],
  })
}
if (!getRegisteredModal('sina-mail-config')) {
  registerModal({
    id: 'sina-mail-config',
    component: HimalayaMailConfigDialog,
  })
}

if (!getScheme('modal-sina-mail-config')) {
  registerModalScheme({
    schemeId: 'modal-sina-mail-config',
    modalType: 'sina-mail-config',
    pattern: 'wegent://modal/sina-mail-config',
    description: 'Open Sina mail configuration dialog',
    examples: ['wegent://modal/sina-mail-config'],
  })
}
