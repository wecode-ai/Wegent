// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const vim = jest.fn(() => [])

export const Vim = {
  defineEx: jest.fn(),
  handleKey: jest.fn(),
}

export const getCM = jest.fn(() => ({}))
