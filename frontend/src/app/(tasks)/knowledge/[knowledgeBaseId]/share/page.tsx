// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { paths } from '@/config/paths'

type PermissionLevel = 'view' | 'edit' | 'manage'

interface KnowledgeBaseInfo {
  id: number
  name: string
  description: string | null
}

export default function KnowledgeSharePage() {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()
  const router = useRouter()
  const params = useParams()
  const knowledgeBaseId = params.knowledgeBaseId

  const [kbInfo, setKbInfo] = useState<KnowledgeBaseInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>('view')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    async function fetchKbInfo() {
      if (!knowledgeBaseId) return

      try {
        const response = await fetch(`/api/knowledge/${knowledgeBaseId}`)
        if (!response.ok) {
          if (response.status === 404) {
            setError(t('share.kb_not_found'))
          } else {
            setError(t('share.fetch_error'))
          }
          return
        }
        const data = await response.json()
        setKbInfo(data)
      } catch (err) {
        setError(t('share.fetch_error'))
      } finally {
        setLoading(false)
      }
    }

    fetchKbInfo()
  }, [knowledgeBaseId, t])

  const handleSubmit = async () => {
    if (!user) {
      router.push(paths.login)
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      const response = await fetch(`/api/knowledge/${knowledgeBaseId}/permissions/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          permission_level: permissionLevel,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        setSubmitError(data.detail || t('share.request_error'))
        return
      }

      setSuccess(true)
    } catch (err) {
      setSubmitError(t('share.request_error'))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">{t('share.error_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (success) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t('share.success_title')}</CardTitle>
            <CardDescription>{t('share.success_description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => router.push(paths.knowledge)}
              className="w-full"
            >
              {t('share.go_to_knowledge')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-base">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('share.title')}</CardTitle>
          <CardDescription>
            {kbInfo?.name}
            {kbInfo?.description && ` - ${kbInfo.description}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!user && (
            <Alert>
              <AlertDescription>{t('share.login_required')}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            <Label className="text-base font-medium">
              {t('share.permission_level')}
            </Label>
            <RadioGroup
              value={permissionLevel}
              onValueChange={(value) => setPermissionLevel(value as PermissionLevel)}
              disabled={!user || submitting}
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="view" id="view" />
                <Label htmlFor="view" className="cursor-pointer">
                  {t('share.permission_view')}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="edit" id="edit" />
                <Label htmlFor="edit" className="cursor-pointer">
                  {t('share.permission_edit')}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="manage" id="manage" />
                <Label htmlFor="manage" className="cursor-pointer">
                  {t('share.permission_manage')}
                </Label>
              </div>
            </RadioGroup>
          </div>

          {submitError && (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleSubmit}
            disabled={!user || submitting}
            className="w-full"
            variant="primary"
          >
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('share.request_access')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}