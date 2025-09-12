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
      title="Welcome!"
      maxWidth="sm"
    >
      <div className="flex flex-col items-center">
        <p className="text-sm text-gray-300 mb-6 text-center leading-relaxed">
          Before you can start using the app, please complete the setup below first!
        </p>
        {needSetTeam && (
          <div className="flex flex-row items-center justify-center gap-2 w-full mb-2">
            <Button
              className="flex-1 min-w-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors duration-200 text-gray-900 bg-[#70a7d7] hover:bg-[#5b8bb3] focus:outline-none"
              style={{ boxShadow: 'none' }}
              onClick={() => {
                handleClose()
                router.push('/dashboard?tab=team')
              }}
            >
              Create Team
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}