# Evaluation Attachment Implementation Plan

## Overview
Implement file attachment functionality for the evaluation module, allowing:
1. Authors to upload attachments for questions (content and criteria)
2. Respondents to upload attachments for answers

## Implementation Tasks

### 1. API Client (evaluation-shared.ts)
- [ ] Add file upload API (presigned URL generation)
- [ ] Add file download API
- [ ] Types for upload/download requests and responses

### 2. Types (evaluation.ts)
- [ ] Add attachment-related types to content_data and criteria_data

### 3. Components
- [ ] EvaluationFileUpload component (reusable file upload UI)
- [ ] AttachmentList component (display attachments)
- [ ] AttachmentPreview component (preview/download)

### 4. Integration
- [ ] Update question creation form
- [ ] Update question detail/edit form
- [ ] Update answer submission form

### 5. i18n
- [ ] Add attachment-related translations

## Technical Approach

The evaluation module uses S3 presigned URLs for direct upload:
1. Client requests presigned PUT URL from backend
2. Client uploads file directly to S3 using presigned URL
3. Client stores the S3 key in content_data/criteria_data

This differs from chat attachments which upload through backend.
