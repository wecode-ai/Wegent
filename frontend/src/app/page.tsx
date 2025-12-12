// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation';
import { paths } from '@/config/paths';

export default function Home() {
  // Redirect to chat page by default
  redirect(paths.chat.getHref());
}
