// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import Image from 'next/image'

export default function LogoHeader() {
  return (
    <div className="flex justify-center items-center space-x-3">
      <Image
        src="/weibo-logo.png"
        alt="Weibo Logo"
        width={48}
        height={48}
        className="object-contain"
      />
      <h2 className="text-3xl font-medium text-white">
        Login to WeCode AI
      </h2>
    </div>
    /* Subtitle */
    /* Separate subtitle as individual element, for page composition */
  )
}

export function LogoSubTitle() {
  return (
    <p className="mt-2 text-center text-sm text-gray-400 font-light">
      your AI assistant for developers
    </p>
  )
}