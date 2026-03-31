// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { getScheme } from '@/lib/scheme'
import { getRegisteredModal, registerModal } from '@/lib/scheme/modal-registry'
import { registerModalScheme } from '@/lib/scheme/modals'

import { MailAccessGuideDialog } from '@wecode/components/devices/MailAccessGuideDialog'
import { MailConfigDialog } from '@wecode/components/devices/MailConfigDialog'

if (!getRegisteredModal('mail-access-guide')) {
  registerModal({
    id: 'mail-access-guide',
    component: MailAccessGuideDialog,
  })
}

if (!getScheme('modal-mail-access-guide')) {
  registerModalScheme({
    schemeId: 'modal-mail-access-guide',
    modalType: 'mail-access-guide',
    pattern: 'wegent://modal/mail-access-guide',
    description: 'Open mail device access guide dialog',
    examples: ['wegent://modal/mail-access-guide'],
  })
}
if (!getRegisteredModal('mail-config')) {
  registerModal({
    id: 'mail-config',
    component: MailConfigDialog,
  })
}

if (!getScheme('modal-mail-config')) {
  registerModalScheme({
    schemeId: 'modal-mail-config',
    modalType: 'mail-config',
    pattern: 'wegent://modal/mail-config',
    description: 'Open mail configuration dialog',
    examples: ['wegent://modal/mail-config'],
  })
}
