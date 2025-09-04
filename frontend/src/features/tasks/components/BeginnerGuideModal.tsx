// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Button } from '@headlessui/react'
import { useRouter } from 'next/navigation'
import Modal from '@/features/common/Modal'
import { paths } from '@/config/paths'

import { useUser } from '@/features/common/UserContext'

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

  // 判断是否需要设置 token
  const needSetToken = !user || !user.git_info || !user.git_info.some(
    (info) => !!info.git_token
  )

  // 根据 teams 长度判断是否需要设置团队
  const needSetTeam = !teams || teams.length === 0;

  // Decide whether to show modal based on needSetToken and needSetTeam
  useEffect(() => {
    // 只有在 userLoading 和 teamLoading 都为 false 时才处理 isOpen
    if (userLoading || teamLoading) {
      return
    }
    if (needSetToken || needSetTeam) {
      setIsOpen(true)
    } else {
      setIsOpen(false)
    }
  }, [needSetToken, needSetTeam, userLoading, teamLoading])

  const handleClose = () => {
    setIsOpen(false)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Welcome!"
      maxWidth="sm"
    >
      <div className="flex flex-col items-center">
        <p className="text-sm text-gray-300 mb-6 text-center leading-relaxed">
          Before you can start using the app, please complete the setup below first!
        </p>
        {(needSetToken || needSetTeam) && (
          <div className="flex flex-row items-center justify-center gap-2 w-full mb-2">
            {needSetToken && (
              <Button
                className="flex-1 min-w-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors duration-200 text-gray-900 bg-[#70a7d7] hover:bg-[#5b8bb3] focus:outline-none"
                style={{ boxShadow: 'none' }}
                onClick={() => {
                  handleClose()
                  router.push(paths.dashboard.bot.getHref())
                }}
              >
                GitToken
              </Button>
            )}
            {needSetTeam && (
              <Button
                className="flex-1 min-w-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors duration-200 text-gray-900 bg-[#70a7d7] hover:bg-[#5b8bb3] focus:outline-none"
                style={{ boxShadow: 'none' }}
                onClick={() => {
                  handleClose()
                  router.push('/dashboard?tab=team')
                }}
              >
                CreateTeam
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}