# Frontend Implementation Guide: Knowledge Base Integration for Chat

## Status: Partially Complete

This document outlines the remaining work to complete the knowledge base integration feature for chat. The backend is fully implemented, and the core UI components have been created.

## Completed Components

### 1. KnowledgeBaseMention.tsx
Location: `frontend/src/features/tasks/components/chat/KnowledgeBaseMention.tsx`

**Purpose**: Autocomplete dropdown for selecting knowledge bases via @ trigger

**Features**:
- Displays personal and team knowledge bases in a dropdown
- Keyboard navigation (Arrow up/down, Enter, Tab, Escape)
- Search filtering by knowledge base name
- Shows metadata (document count, description, team name)
- Groups personal and team knowledge bases

### 2. CitationCard.tsx
Location: `frontend/src/features/tasks/components/chat/CitationCard.tsx`

**Purpose**: Display citations/references in AI responses

**Features**:
- Shows up to 3 citations with expand indicator
- Displays document name, knowledge base, snippet preview, and relevance score
- Ghost card variant with hover effect
- Responsive layout

## Remaining Implementation Tasks

### Task 1: Update ChatInput Component

**File**: `frontend/src/features/tasks/components/ChatInput.tsx`

**Changes Required**:

1. Add knowledge base state management:
```typescript
// Add after existing mention state
const [showKnowledgeMention, setShowKnowledgeMention] = useState(false);
const [knowledgeMentionPosition, setKnowledgeMentionPosition] = useState({ top: 0, left: 0 });
const [knowledgeQuery, setKnowledgeQuery] = useState('');
const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<SelectedKnowledgeBase[]>([]);
```

2. Add accessible knowledge bases loading:
```typescript
const [accessibleKnowledge, setAccessibleKnowledge] = useState<AccessibleKnowledgeResponse | null>(null);

useEffect(() => {
  async function loadAccessibleKnowledge() {
    try {
      const data = await getAccessibleKnowledge();
      setAccessibleKnowledge(data);
    } catch (error) {
      console.error('Failed to load accessible knowledge:', error);
    }
  }
  loadAccessibleKnowledge();
}, []);
```

3. Modify input handler to detect @ for knowledge bases:
```typescript
// In the handleInput function, after existing @ detection for teams:
// Check if this is a knowledge base mention (not in group chat mode or already has team mention)
if (char === '@' && !isGroupChat) {
  // Get cursor position for dropdown
  const selection = window.getSelection();
  const range = selection?.getRangeAt(0);
  if (range) {
    const rect = range.getBoundingClientRect();
    setKnowledgeMentionPosition({
      top: rect.top,
      left: rect.left,
    });
    setShowKnowledgeMention(true);
    setKnowledgeQuery('');
  }
}
```

4. Add knowledge base selection handler:
```typescript
const handleKnowledgeSelect = useCallback((kb: SelectedKnowledgeBase) => {
  // Add to selected knowledge bases
  setSelectedKnowledgeBases(prev => {
    // Prevent duplicates
    if (prev.find(k => k.id === kb.id)) {
      return prev;
    }
    return [...prev, kb];
  });

  // Replace @query with @knowledge_base_name in the message
  const newMessage = message.replace(/@[^@]*$/, `@${kb.name} `);
  setMessage(newMessage);
  setShowKnowledgeMention(false);
}, [message, setMessage]);
```

5. Add visual tags for selected knowledge bases below input:
```tsx
{/* Knowledge base tags */}
{selectedKnowledgeBases.length > 0 && (
  <div className="flex flex-wrap gap-1 mt-2">
    {selectedKnowledgeBases.map(kb => (
      <Tag
        key={kb.id}
        variant="info"
        closable
        onClose={() => {
          setSelectedKnowledgeBases(prev => prev.filter(k => k.id !== kb.id));
        }}
      >
        <Database className="w-3 h-3 mr-1" />
        {kb.name}
      </Tag>
    ))}
  </div>
)}
```

6. Add KnowledgeBaseMention component to render:
```tsx
{/* After MentionAutocomplete */}
{showKnowledgeMention && accessibleKnowledge && (
  <KnowledgeBaseMention
    personal={accessibleKnowledge.personal}
    team={accessibleKnowledge.team}
    query={knowledgeQuery}
    onSelect={handleKnowledgeSelect}
    onClose={() => setShowKnowledgeMention(false)}
    position={knowledgeMentionPosition}
  />
)}
```

7. Export selected knowledge bases via new prop:
```typescript
interface ChatInputProps {
  // ... existing props
  onKnowledgeBasesChange?: (kbs: SelectedKnowledgeBase[]) => void;
}

// Call when selectedKnowledgeBases changes
useEffect(() => {
  onKnowledgeBasesChange?.(selectedKnowledgeBases);
}, [selectedKnowledgeBases, onKnowledgeBasesChange]);
```

### Task 2: Update ChatArea Component

**File**: `frontend/src/features/tasks/components/ChatArea.tsx`

**Changes Required**:

1. Add knowledge base state in ChatArea:
```typescript
const [selectedKnowledgeBases, setSelectedKnowledgeBases] = useState<SelectedKnowledgeBase[]>([]);
```

2. Pass callback to ChatInput:
```tsx
<ChatInput
  // ... existing props
  onKnowledgeBasesChange={setSelectedKnowledgeBases}
/>
```

3. Update handleSendMessage to include knowledge_bases:
```typescript
const knowledge_bases = selectedKnowledgeBases.length > 0
  ? selectedKnowledgeBases.map(kb => ({
      knowledge_base_id: kb.id,
      name: kb.name,
    }))
  : undefined;

// Include in StreamChatRequest
const response = await fetch('/api/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    // ... existing fields
    knowledge_bases,
  }),
});
```

4. Keep knowledge bases in session (optional persistence):
```typescript
// After message is sent, keep knowledge bases for next message
// Don't clear selectedKnowledgeBases unless user manually removes tags
```

### Task 3: Update MessagesArea Component

**File**: `frontend/src/features/tasks/components/MessagesArea.tsx`

**Changes Required**:

1. Add citation state:
```typescript
const [messageCitations, setMessageCitations] = useState<Record<number, Citation[]>>({});
```

2. In the SSE stream handler, detect citation events:
```typescript
// In handleStreamChunk or equivalent
if (data.type === 'citation') {
  setMessageCitations(prev => ({
    ...prev,
    [subtaskId]: [...(prev[subtaskId] || []), data.data],
  }));
}
```

3. Display citations before AI message:
```tsx
{messageCitations[subtask.id] && (
  <CitationCard citations={messageCitations[subtask.id]} />
)}
<MessageContent>{subtask.content}</MessageContent>
```

4. Handle fallback notification:
```typescript
if (data.type === 'metadata' && data.data.knowledge_base_fallback) {
  toast({
    title: 'Knowledge base unavailable',
    description: 'Unable to retrieve from knowledge bases. Switched to normal chat mode.',
    variant: 'default',
  });
}
```

### Task 4: Update API Types

**File**: `frontend/src/apis/chat.ts`

**Changes Required**:

1. Add knowledge base types:
```typescript
export interface KnowledgeBaseRef {
  knowledge_base_id: number;
  name: string;
}
```

2. Update StreamChatRequest interface:
```typescript
export interface StreamChatRequest {
  // ... existing fields
  knowledge_bases?: KnowledgeBaseRef[];
}
```

### Task 5: Add i18n Translations

**Files**:
- `frontend/src/i18n/locales/en.ts`
- `frontend/src/i18n/locales/zh-CN.ts`

**Translations Needed**:

```typescript
// en.ts
chat: {
  knowledgeBase: {
    noResults: 'No knowledge bases found',
    mentionHint: 'Type @ to reference knowledge bases',
  },
},

// zh-CN.ts
chat: {
  knowledgeBase: {
    noResults: '未找到知识库',
    mentionHint: '输入 @ 引用知识库',
  },
},
```

### Task 6: Session-Level Persistence (Optional Enhancement)

**File**: `frontend/src/features/tasks/contexts/chatStreamContext.tsx`

**Purpose**: Persist selected knowledge bases across messages in a task session

**Implementation**:
```typescript
// Add to context
const [activeKnowledgeBases, setActiveKnowledgeBases] = useState<Record<number, SelectedKnowledgeBase[]>>({});

// Provide methods to get/set knowledge bases for a task
const getKnowledgeBasesForTask = (taskId: number) => activeKnowledgeBases[taskId] || [];
const setKnowledgeBasesForTask = (taskId: number, kbs: SelectedKnowledgeBase[]) => {
  setActiveKnowledgeBases(prev => ({
    ...prev,
    [taskId]: kbs,
  }));
};
```

## Testing Checklist

### Backend Testing
- [ ] Test `/api/chat/stream` with `knowledge_bases` parameter
- [ ] Verify RAG retrieval is called correctly
- [ ] Verify citations are sent via SSE
- [ ] Verify fallback notification is sent when retrieval fails
- [ ] Test with multiple knowledge bases
- [ ] Test with non-existent knowledge base IDs
- [ ] Test permission checks for knowledge bases

### Frontend Testing
- [ ] Test @ trigger shows knowledge base dropdown
- [ ] Test keyboard navigation in dropdown
- [ ] Test selecting knowledge bases adds tags
- [ ] Test removing tags via close button
- [ ] Test knowledge bases are sent in API request
- [ ] Test citations are displayed in message
- [ ] Test fallback toast notification
- [ ] Test session persistence (if implemented)
- [ ] Test with no accessible knowledge bases
- [ ] Test concurrent use with group chat @mentions

## Known Limitations

1. **Embedding Model Hardcoded**: The `_get_embedding_config` method in `knowledge_retriever.py` returns a hardcoded default embedding model. This should be read from the Retriever configuration in future.

2. **Retrieval Constants**: Module-level constants in `knowledge_retriever.py` are temporary. In production, these should be read from Retriever CRD spec.

3. **No Document Detail Page**: Citations don't link to document detail pages yet (requires backend API for document viewing).

4. **No Chunk Index**: Citation deduplication uses `chunk_index` from metadata, but this may not be set by all storage backends.

## Future Enhancements

1. **Retriever Configuration Integration**: Replace module-level constants with values from Retriever CRD
2. **Smart Knowledge Base Suggestions**: Auto-suggest relevant knowledge bases based on task context
3. **Citation Click-Through**: Add document detail page and citation jump links
4. **Knowledge Base Preview**: Show preview/stats when hovering over knowledge base tags
5. **Recent Knowledge Bases**: Track and suggest recently used knowledge bases
6. **Bulk Knowledge Base Selection**: Allow selecting multiple knowledge bases at once
7. **Knowledge Base Search**: Add search/filter in the mention dropdown

## Migration Path

When moving from temporary constants to Retriever configuration:

1. Add retrieval settings to Retriever CRD spec
2. Update `_get_embedding_config` to read from Retriever
3. Update `_retrieve_chunks` to use Retriever-specific settings
4. Remove all module-level constants from `knowledge_retriever.py`
5. Update documentation to reflect configuration source
