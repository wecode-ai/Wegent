// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Button } from 'antd'
import { useRouter } from 'next/navigation'
import Modal from '@/features/common/Modal'
import { paths } from '@/config/paths'

import { useUser } from '@/features/common/UserContext'
import { useTranslation } from 'react-i18next'

import type { Team } from '@/types/api';

interface BeginnerGuideModalProps {
  teams: Team[]
  teamLoading: boolean
}

export default function BeginnerGuideModal({
  teams,
  teamLoading
}: BeginnerGuideModalProps) {
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const { user, isLoading: userLoading } = useUser()
  const { t } = useTranslation()
  // Determine if team needs to be set based on teams length
  const needSetTeam = !teams || teams.length === 0;

  // Decide whether to show modal based on needSetTeam only
  useEffect(() => {
    // Only process isOpen when both userLoading and teamLoading are false
    if (userLoading || teamLoading) {
      return
    }
    if (needSetTeam) {
      setIsOpen(true)
    } else {
      setIsOpen(false)
    }
  }, [needSetTeam, userLoading, teamLoading])

  const handleClose = () => {
    setIsOpen(false)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('guide.title')}
      maxWidth="sm"
    >
      <div className="flex flex-col items-center">
        <p className="text-sm text-text-secondary mb-6 text-center leading-relaxed">
            {t('guide.description')}
        </p>
        {needSetTeam && (
          <div className="flex flex-row items-center justify-center gap-2 w-full mb-2">
            <Button
              type="primary"
              size="small"
              style={{ minWidth: '100px' }}
              onClick={() => {
                handleClose()
                router.push(paths.settings.team.getHref())
              }}
            >
                {t("guide.create_team")}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
