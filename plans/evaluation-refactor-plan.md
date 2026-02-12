# Evaluation Module Refactoring Plan

## Overview

Refactor evaluation module from CRUD-based to role-based architecture as specified in `evaluation-module-technical-spec.md`.

## Phase 1: Backend API Restructuring

### 1.1 New Directory Structure
```
backend/wecode/api/evaluation/
├── __init__.py           # Updated main router
├── author.py             # NEW - Author endpoints
├── respondent.py         # NEW - Respondent endpoints
├── grader.py             # RENAMED from grading.py - Grader endpoints
├── shared.py             # NEW - Shared endpoints
└── _legacy/              # OLD files to be removed after migration
    ├── topics.py
    ├── questions.py
    ├── answers.py
    ├── permissions.py
    └── grading.py
```

### 1.2 Author Router (`/author/*`)
- GET    /author/topics                  - My created topics
- POST   /author/topics                  - Create topic
- GET    /author/topics/{id}             - Topic detail
- PUT    /author/topics/{id}             - Update topic
- DELETE /author/topics/{id}             - Delete topic
- POST   /author/topics/{id}/publish     - Publish topic
- POST   /author/topics/{id}/rollback    - Rollback version (NEW)
- GET    /author/topics/{id}/versions    - Version history (NEW)
- GET    /author/topics/{id}/statistics  - Statistics
- POST   /author/topics/{id}/questions   - Add question
- GET    /author/topics/{id}/questions   - List questions
- PUT    /author/questions/{id}          - Update question
- POST   /author/questions/{id}/publish  - Publish question
- GET    /author/questions/{id}/versions - Question versions (NEW)
- PUT    /author/topics/{id}/permissions - Set permissions
- GET    /author/topics/{id}/graders     - Get graders (NEW)

### 1.3 Respondent Router (`/respondent/*`)
- GET  /respondent/topics                    - Available topics
- GET  /respondent/topics/{id}               - Topic detail (respondent view)
- GET  /respondent/topics/{id}/questions     - Questions list
- GET  /respondent/questions/{id}            - Question detail
- POST /respondent/questions/{id}/answers    - Submit answer
- GET  /respondent/history                   - My answer history (NEW)
- GET  /respondent/answers/{id}              - Answer detail (NEW)
- GET  /respondent/reports                   - My grading reports (NEW)
- GET  /respondent/reports/{id}              - Report detail (NEW)

### 1.4 Grader Router (`/grader/*`)
- GET  /grader/dashboard                 - Dashboard stats (NEW)
- GET  /grader/tasks                     - Grading tasks list
- GET  /grader/tasks/{id}                - Task detail
- POST /grader/tasks/{id}/execute        - Execute grading
- POST /grader/tasks/{id}/retry          - Retry grading (NEW)
- POST /grader/tasks/{id}/publish        - Publish report
- GET  /grader/answers                   - Answers list (NEW)
- GET  /grader/answers/{id}              - Answer detail + task (NEW)
- GET  /grader/topics/{id}/answers       - Topic answers (NEW)
- GET  /grader/reports                   - Published reports (NEW)
- GET  /grader/reports/{id}              - Report detail

### 1.5 Shared Router (`/shared/*`)
- GET  /shared/reports/{id}              - View report (permission check)
- POST /shared/files/upload              - File upload (NEW)
- GET  /shared/files/download            - File download (NEW)

## Phase 2: Frontend Route Restructuring

### 2.1 New App Router Structure
```
frontend/wecode/app/(evaluation)/
├── layout.tsx
├── page.tsx                    # Role selector/redirect
├── author/
│   ├── page.tsx               # My topics list
│   └── topics/
│       ├── new/page.tsx       # Wizard create
│       └── [id]/
│           ├── page.tsx       # Topic management
│           ├── edit/page.tsx
│           ├── questions/new/page.tsx
│           ├── permissions/page.tsx
│           └── versions/[v]/page.tsx
├── respondent/
│   ├── page.tsx               # Available topics
│   ├── topics/[id]/
│   │   ├── page.tsx          # Topic detail
│   │   └── questions/[qid]/page.tsx  # Answer page
│   └── history/page.tsx       # Answer history
├── grader/
│   ├── page.tsx               # Dashboard
│   ├── tasks/page.tsx
│   ├── topics/[id]/page.tsx
│   ├── answers/[id]/page.tsx  # Core grading page
│   └── reports/page.tsx
└── reports/[id]/page.tsx      # Shared report view
```

## Phase 3: Component Extraction

### 3.1 Author Components
- TopicWizard - Multi-step topic creation
- QuestionEditor - Rich question editing
- PermissionPanel - User permission management
- VersionHistory - Version timeline view

### 3.2 Respondent Components
- TopicCard - Topic overview card
- QuestionViewer - Question display
- AnswerEditor - Answer submission form
- HistoryList - Answer history list

### 3.3 Grader Components
- DashboardStats - Stats overview
- TaskList - Grading task list
- GradingWorkspace - Core grading UI
- ReportViewer - Report display
- ReportEditor - Report editing

### 3.4 Common Components
- FileUploader - File upload widget
- FileDownloader - File download widget
- VersionBadge - Version indicator
- StatusBadge - Status indicator

## Phase 4: API/Types/Hooks Split

### 4.1 API Files
- frontend/wecode/api/author.ts
- frontend/wecode/api/respondent.ts
- frontend/wecode/api/grader.ts
- frontend/wecode/api/shared.ts

### 4.2 Type Files
- frontend/wecode/types/author.ts
- frontend/wecode/types/respondent.ts
- frontend/wecode/types/grader.ts
- frontend/wecode/types/common.ts

### 4.3 Hook Files
- frontend/wecode/hooks/useAuthorTopics.ts
- frontend/wecode/hooks/useRespondentTopics.ts
- frontend/wecode/hooks/useGradingTasks.ts
- frontend/wecode/hooks/useEvaluationAuth.ts

## Status Tracking

- [ ] Phase 1 - Backend API restructuring
- [ ] Phase 2 - Frontend route restructuring
- [ ] Phase 3 - Component extraction
- [ ] Phase 4 - API/Types/Hooks split
- [ ] Phase 5 - Testing and cleanup
