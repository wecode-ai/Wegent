// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '../common/StatusBadge'
import { VisibilityBadge } from '../common/VisibilityBadge'
import type { Topic } from '@wecode/types/evaluation'

interface TopicCardProps {
  topic: Topic
  basePath?: string
}

/**
 * Topic card component for displaying topic overview.
 * Used in author and grader topic lists.
 */
export function TopicCard({ topic, basePath = '/evaluation/author/topics' }: TopicCardProps) {
  const router = useRouter()

  const handleClick = () => {
    router.push(`${basePath}/${topic.id}`)
  }

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary" onClick={handleClick}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{topic.name}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {topic.description && (
          <p className="mb-3 line-clamp-2 text-sm text-text-secondary">{topic.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={topic.status} type="topic" />
          <VisibilityBadge visibility={topic.visibility} />
          {topic.current_version && (
            <span className="text-xs text-text-muted">v{topic.current_version}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
