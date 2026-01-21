// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { SubscriptionDetailPage } from '@/features/feed/components/SubscriptionDetailPage'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function FeedSubscriptionDetailPage({ params }: PageProps) {
  const { id } = await params
  return <SubscriptionDetailPage subscriptionId={parseInt(id, 10)} />
}
