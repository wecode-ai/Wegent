/**
 * E2E Test Fixtures Index
 * Export all fixtures for easy importing
 */

import * as path from 'path';

// Custom test fixtures
export { test, expect, PageHelpers, TestData } from './test-fixtures';
export type { TestFixtures } from './test-fixtures';

// Data builders
export { DataBuilders } from './data-builders';
export type {
  BotData,
  ModelData,
  TeamData,
  GroupData,
  UserData,
  TaskData,
  ShellData,
  WorkspaceData,
} from './data-builders';

// Media test files
const MEDIA_DIR = path.join(__dirname, 'media');

/**
 * Paths to test media files for E2E testing
 */
export const TEST_MEDIA_FILES = {
  /** Test PNG image (1x1 pixel) */
  IMAGE_PNG: path.join(MEDIA_DIR, 'test-image.png'),
  /** Test PDF document */
  PDF: path.join(MEDIA_DIR, 'test-document.pdf'),
  /** Test Word document (.docx) */
  DOCX: path.join(MEDIA_DIR, 'test-document.docx'),
  /** Test PowerPoint presentation (.pptx) */
  PPTX: path.join(MEDIA_DIR, 'test-presentation.pptx'),
} as const;

/**
 * Path to the general test file
 */
export const TEST_FILE_PATH = path.join(__dirname, 'test-file.txt');
