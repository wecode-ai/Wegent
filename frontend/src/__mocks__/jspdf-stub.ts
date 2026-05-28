// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Stub for jsPDF to avoid ESM import issues in Jest
const jsPDF = jest.fn().mockImplementation(() => ({
  save: jest.fn(),
  addPage: jest.fn(),
  setFont: jest.fn(),
  setFontSize: jest.fn(),
  setTextColor: jest.fn(),
  setDrawColor: jest.fn(),
  setFillColor: jest.fn(),
  setLineWidth: jest.fn(),
  text: jest.fn(),
  line: jest.fn(),
  rect: jest.fn(),
  addImage: jest.fn(),
  addFileToVFS: jest.fn(),
  addFont: jest.fn(),
  getNumberOfPages: jest.fn().mockReturnValue(1),
  setPage: jest.fn(),
  internal: {
    pageSize: {
      getWidth: jest.fn().mockReturnValue(210),
      getHeight: jest.fn().mockReturnValue(297),
    },
  },
}))

export default jsPDF
