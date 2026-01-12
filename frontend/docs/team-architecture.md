# Team Selection Architecture Documentation

## 1. Architecture Overview

### 1.1 Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                      ChatPageDesktop / ChatPageMobile           │
│                    (uses teamService.useTeams() to fetch data)  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ props: teams, isTeamsLoading
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                           ChatArea                              │
│              (Core team selection logic + useChatAreaState)     │
├─────────────────────────────────────────────────────────────────┤
│  State Management:                                              │
│    - selectedTeam (from useChatAreaState)                       │
│    - handleTeamChange, handleTeamSelect                         │
│  Refs:                                                          │
│    - hasInitializedTeamRef                                      │
│    - lastSyncedTaskIdRef                                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐     ┌─────────────────┐     ┌─────────────────┐
│QuickAccessCards│     │  ChatInputCard  │     │  MessagesArea   │
│ (Team quick    │     │  (passes team)  │     │ (displays msgs) │
│  selection)    │     └─────────────────┘     └─────────────────┘
├───────────────┤
│MobileTeamSelector│
│ (mobile picker)  │
└───────────────┘
```

### 1.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                Backend API                                   │
│                             GET /teams?scope=all                             │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           teamApis.getTeams()                                │
│                         /src/apis/team.ts                                    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        teamService.useTeams()                                │
│              /src/features/tasks/service/teamService.ts                      │
│                                                                              │
│  Returns: { teams: Team[], isTeamsLoading: boolean, refreshTeams: () => void }│
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ChatPageDesktop / ChatPageMobile                        │
│                                                                              │
│  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ props
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               ChatArea                                       │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        useChatAreaState()                              │  │
│  │  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)  │  │
│  │  const handleTeamChange = useCallback((team) => {                     │  │
│  │    setSelectedTeam(team)                                              │  │
│  │    saveLastTeamByMode(team.id, taskType)  // Save to localStorage     │  │
│  │  }, [taskType])                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Team Selection useEffect:                                                   │
│    Case 1: Sync from taskDetail (viewing existing task)                     │
│    Case 2: Restore from localStorage (new conversation)                     │
│    Case 3: Validate current selection is valid                              │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │                                                       │
        ▼                                                       ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│         QuickAccessCards          │   │           localStorage            │
│                                   │   │     /src/utils/userPreferences.ts │
│  onTeamSelect → handleTeamSelect  │   │                                   │
│    └── handleTeamChange(team)     │   │  Keys:                            │
│    └── saveLastTeamByMode()       │───│  - wegent_last_team_id_chat       │
│                                   │   │  - wegent_last_team_id_code       │
│  MobileTeamSelector (mobile)      │   │  - wegent_last_team_id (compat)   │
└───────────────────────────────────┘   └───────────────────────────────────┘
```

## 2. State Management

### 2.1 selectedTeam State Location

| Location        | File                  | Description                        |
| --------------- | --------------------- | ---------------------------------- |
| Primary State   | `useChatAreaState.ts` | `useState<Team \| null>(null)`     |
| Update Method   | `useChatAreaState.ts` | `handleTeamChange(team)`           |
| Selection Logic | `ChatArea.tsx`        | `useEffect` handles auto-selection |

### 2.2 Ref Tracking

```typescript
// ChatArea.tsx
const hasInitializedTeamRef = useRef(false) // Whether initialization is complete
const lastSyncedTaskIdRef = useRef<number | null>(null) // Last synced task ID
```

**Purpose:**

- `hasInitializedTeamRef`: Prevents repeated restoration from localStorage after page load
- `lastSyncedTaskIdRef`: Prevents duplicate team sync for the same task

## 3. Flow Diagrams

### 3.1 Page Load Flow

```
┌─────────────────┐
│   Page Load     │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│ teamService.useTeams() fetches  │
└────────────────┬────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  filteredTeams.length > 0 ?    │
└────────────────┬────────────────┘
         │
    ┌────┴────┐
    │ Yes     │ No → Exit
    ▼
┌─────────────────────────────────┐
│   Check if URL has taskId       │
└────────────────┬────────────────┘
         │
    ┌────┴────────────────────┐
    │                         │
    ▼ Has taskId              ▼ No taskId
┌─────────────────┐    ┌─────────────────────────────┐
│ Case 1:         │    │ Case 2:                     │
│ Sync from       │    │ Restore from localStorage   │
│ taskDetail      │    │ getLastTeamIdByMode(mode)   │
└────────┬────────┘    └──────────────┬──────────────┘
         │                            │
         ▼                            ▼
┌──────────────────────┐    ┌──────────────────────────┐
│ URL taskId ===       │    │ Found saved team?        │
│ taskDetail.id ?      │    │                          │
└──────────┬───────────┘    └──────────┬───────────────┘
           │                           │
      ┌────┴────┐                 ┌────┴────┐
      │ Yes     │ No → Wait      │ Yes     │ No
      ▼                          ▼         ▼
┌────────────────┐        ┌────────────┐ ┌─────────────┐
│Sync taskDetail │        │Restore that│ │Select first │
│ team           │        │team        │ │team         │
└────────────────┘        └────────────┘ └─────────────┘
```

### 3.2 User Manual Team Selection Flow

```
┌─────────────────────────────────┐
│  User clicks Team card/picker   │
│  (QuickAccessCards)             │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│   Need mode switch (chat↔code)? │
└────────────────┬────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
        ▼ Yes             ▼ No
┌───────────────────┐  ┌───────────────────────────────┐
│Save to target mode│  │  handleTeamSelect(team)       │
│localStorage       │  │    ├── handleTeamChange(team) │
│                   │  │    └── saveLastTeamByMode()   │
│router.push(path)  │  └───────────────────────────────┘
│New page restores  │
└───────────────────┘
```

### 3.3 Viewing Existing Task - Team Sync Flow

```
┌─────────────────────────────────┐
│    User clicks task list item   │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  URL updates: /chat?taskId=123  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│   taskContext loads             │
│   selectedTaskDetail            │
│   (contains team info)          │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  ChatArea useEffect triggers    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│  URL taskId === taskDetail.id ? │
└────────────────┬────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
        ▼ Yes             ▼ No
┌───────────────────┐  ┌───────────────────────────┐
│lastSyncedTaskId   │  │Wait for correct taskDetail│
│!== current taskId?│  │(prevents race condition)  │
└────────┬──────────┘  └───────────────────────────┘
         │
    ┌────┴────┐
    │ Yes     │ No → Skip (already synced)
    ▼
┌───────────────────┐
│handleTeamChange   │
│(taskDetail.team)  │
│                   │
│Update:            │
│lastSyncedTaskIdRef│
│hasInitializedRef  │
└───────────────────┘
```

## 4. UML Class Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   Team                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ + id: number                                                                 │
│ + name: string                                                               │
│ + bind_mode: ('chat' | 'code')[] | null                                     │
│ + share_status: number                                                       │
│ + namespace: string                                                          │
│ + icon: string                                                               │
│ + user?: User                                                                │
│ + workflow?: Workflow                                                        │
│ + agent_type?: string                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      △
                                      │ uses
┌─────────────────────────────────────┴───────────────────────────────────────┐
│                              ChatAreaState                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ + selectedTeam: Team | null                                                  │
│ + handleTeamChange: (team: Team | null) => void                             │
│ + selectedModel: Model | null                                                │
│ + selectedRepo: Repository | null                                            │
│ + selectedBranch: string                                                     │
│ + taskInputMessage: string                                                   │
│ + ... (other state)                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ «hook» useChatAreaState(options): ChatAreaState                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      △
                                      │ uses
┌─────────────────────────────────────┴───────────────────────────────────────┐
│                                ChatArea                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ Props:                                                                       │
│   + teams: Team[]                                                            │
│   + isTeamsLoading: boolean                                                  │
│   + taskType: 'chat' | 'code'                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ Internal:                                                                    │
│   - filteredTeams: Team[]                                                    │
│   - selectedTeam: Team | null (from useChatAreaState)                       │
│   - handleTeamChange: (team) => void                                        │
│   - handleTeamSelect: (team) => void                                        │
│   - hasInitializedTeamRef: Ref<boolean>                                     │
│   - lastSyncedTaskIdRef: Ref<number | null>                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Methods:                                                                     │
│   + useEffect (Team selection logic)                                        │
│   + useEffect (Reset lastSyncedTaskIdRef)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ renders
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
              ▼                       ▼                       ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  QuickAccessCards   │  │   ChatInputCard     │  │    MessagesArea     │
├─────────────────────┤  ├─────────────────────┤  ├─────────────────────┤
│ + teams: Team[]     │  │ + selectedTeam      │  │ + selectedTeam      │
│ + selectedTeam      │  │ + onTeamChange      │  └─────────────────────┘
│ + onTeamSelect      │  └─────────────────────┘
│ + currentMode       │
├─────────────────────┤
│MobileTeamSelector   │
│ (mobile)            │
└─────────────────────┘
```

## 5. Sequence Diagrams

### 5.1 Page Load - Viewing Existing Task

```
┌────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────────┐
│  User  │  │  Router  │  │taskContext│  │ ChatArea │  │useChatAreaState │
└───┬────┘  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └────────┬────────┘
    │            │              │             │                 │
    │ Click task │              │             │                 │
    │───────────>│              │             │                 │
    │            │              │             │                 │
    │            │ navigate     │             │                 │
    │            │ /chat?taskId=123           │                 │
    │            │─────────────>│             │                 │
    │            │              │             │                 │
    │            │              │ fetch       │                 │
    │            │              │ taskDetail  │                 │
    │            │              │────────────>│                 │
    │            │              │             │                 │
    │            │              │             │ useEffect       │
    │            │              │             │ triggers        │
    │            │              │             │────────────────>│
    │            │              │             │                 │
    │            │              │             │ check: URL      │
    │            │              │             │ taskId ===      │
    │            │              │             │ detail.id?      │
    │            │              │             │<────────────────│
    │            │              │             │                 │
    │            │              │             │ Yes: sync team  │
    │            │              │             │────────────────>│
    │            │              │             │                 │
    │            │              │             │handleTeamChange │
    │            │              │             │<────────────────│
    │            │              │             │                 │
    │            │              │             │ update refs     │
    │            │              │             │────────────────>│
    │            │              │             │                 │
```

### 5.2 User Manual Team Selection

```
┌────────┐  ┌─────────────────┐  ┌──────────┐  ┌─────────────────┐  ┌──────────────┐
│  User  │  │QuickAccessCards │  │ ChatArea │  │useChatAreaState │  │ localStorage │
└───┬────┘  └────────┬────────┘  └────┬─────┘  └────────┬────────┘  └──────┬───────┘
    │                │               │                 │                  │
    │ Click Team card│               │                 │                  │
    │───────────────>│               │                 │                  │
    │                │               │                 │                  │
    │                │onTeamSelect   │                 │                  │
    │                │(team)         │                 │                  │
    │                │──────────────>│                 │                  │
    │                │               │                 │                  │
    │                │               │handleTeamSelect │                  │
    │                │               │(team)           │                  │
    │                │               │────────────────>│                  │
    │                │               │                 │                  │
    │                │               │                 │ setSelectedTeam  │
    │                │               │                 │────────────────>│
    │                │               │                 │                  │
    │                │               │                 │saveLastTeamByMode│
    │                │               │                 │─────────────────>│
    │                │               │                 │                  │
    │                │               │                 │                  │ store
    │                │               │                 │                  │─────┐
    │                │               │                 │                  │     │
    │                │               │                 │                  │<────┘
    │                │               │                 │                  │
```

## 6. Key File Index

| File Path                                                        | Responsibility                                |
| ---------------------------------------------------------------- | --------------------------------------------- |
| `/src/features/tasks/components/chat/ChatArea.tsx`               | Core chat component with Team selection logic |
| `/src/features/tasks/components/chat/useChatAreaState.ts`        | State management Hook                         |
| `/src/features/tasks/components/chat/QuickAccessCards.tsx`       | Team quick selection cards                    |
| `/src/features/tasks/components/selector/MobileTeamSelector.tsx` | Mobile Team selector                          |
| `/src/features/tasks/components/selector/TeamSelector.tsx`       | Desktop Team selector (not directly used)     |
| `/src/utils/userPreferences.ts`                                  | localStorage utility functions                |
| `/src/features/tasks/service/teamService.ts`                     | Team data fetching service                    |
| `/src/apis/team.ts`                                              | Team API interface                            |

## 7. Design Decisions

### 7.1 Race Condition Prevention

```typescript
// Only sync when URL taskId matches taskDetail.id
if (selectedTaskDetail.id.toString() === taskIdFromUrl) {
  // Sync team
} else {
  // Wait for correct taskDetail to load
  return
}
```

**Why is this check needed?**

- When users rapidly switch tasks, URL may update but taskDetail still has old data
- Without this check, the wrong team would be displayed

### 7.2 Mode-Separated Storage

```typescript
// Chat and Code modes store separately
localStorage.setItem('wegent_last_team_id_chat', teamId)
localStorage.setItem('wegent_last_team_id_code', teamId)
```

**Why separate storage?**

- Users may use different default teams in Chat vs Code modes
- Switching modes restores the team last used in that mode

### 7.3 Ref Tracking to Avoid Duplicate Operations

```typescript
const hasInitializedTeamRef = useRef(false)
const lastSyncedTaskIdRef = useRef<number | null>(null)
```

**Purpose:**

- `hasInitializedTeamRef`: Prevents re-restoring from localStorage every time filteredTeams changes
- `lastSyncedTaskIdRef`: Prevents duplicate team sync for the same task (even if taskDetail reference changes)

## 8. Potential Issues and Considerations

### 8.1 bind_mode Filtering

Teams are filtered by `bind_mode` field:

- `bind_mode = ['chat']` → Only shown on Chat page
- `bind_mode = ['code']` → Only shown on Code page
- `bind_mode = ['chat', 'code']` or `null` → Shown on both pages
- `bind_mode = []` → Not shown

### 8.2 Team Not in Filtered List

When the task's team is not in the current mode's filtered list:

1. First try to find matching team in filteredTeams
2. If not found, directly use the team object from taskDetail
3. This ensures correct team display even if team is filtered out

### 8.3 Component Re-renders

Since `selectedTeam` is in the useEffect dependency array:

- Team changes trigger useEffect re-execution
- But `lastSyncedTaskIdRef` check prevents unnecessary updates

---

_Document generated: 2026-01-11_
_Based on code version: wegent/comprehensive-responsive-design-for-chat-and-code-pages_
