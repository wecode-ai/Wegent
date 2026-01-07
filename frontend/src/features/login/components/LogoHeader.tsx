// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import Image from 'next/image'
import { useTranslation } from '@/hooks/useTranslation'

export default function LogoHeader() {
  const { t } = useTranslation()
  return (
    <div className="flex justify-center items-center space-x-3">
      <Image
        src="/weibo-logo.png"
        alt="Weibo Logo"
        width={48}
        height={48}
        className="object-contain"
      />
      <h2 className="text-3xl font-medium text-text-primary">{t('common:auth.login_title')}</h2>
    </div>
    /* Subtitle */
    /* Separate subtitle as individual element, for page composition */
  )
}

export function LogoSubTitle() {
  const { t } = useTranslation()
  return (
    <p className="mt-2 text-center text-sm text-text-muted font-light">
      {t('common:auth.login_subtitle')}
    </p>
  )
}
