---
sidebar_position: 1
---

# Evaluation Respondent Question Page Redesign

## Overview

Redesign the AI考评 (Evaluation) module's question answering page (`/evaluation/respondent/topics/:id/questions/:qid`) to improve visual quality and user experience, transforming it from a cluttered card-based UI to a professional, efficient, and aesthetically pleasing interface.

## Design Goals

1. **Professional Examination Feel** - Create a serious, focused atmosphere similar to standardized tests
2. **Modern Learning Aesthetic** - Clean, minimal design inspired by Notion and Linear
3. **Enterprise Efficiency** - High information density with clear hierarchy and efficient workflows

## Current Issues

1. Excessive card nesting creates visual clutter
2. Tab-based navigation fragments the user experience
3. Limited breathing room due to max-w-3xl constraint
4. Badge overuse creates visual noise
5. No sense of progress or location within the question set
6. Instructions buried in tabs
7. Text input emphasized over file upload (wrong priority)

## Design Decisions

### Layout Architecture

**Desktop (≥768px):**
- Split-pane layout: Left 45% (question) / Right 55% (answer)
- Independent scrolling for both panes
- Resizable handle for user customization

**Mobile (<768px):**
- Single column stack layout
- Top progress bar with timer
- Sequential navigation only

### Navigation Strategy

- **No left sidebar navigation** - Avoids information overload
- **Top progress bar** - Shows "Question X/Y" with visual progress
- **Timer display** - Shows elapsed time (⏱️ MM:SS)
- **Previous/Next buttons** - Only navigation controls
- **No global exit** - Must complete or explicitly return to list
- **No "AI考评" branding in header** - Immersive experience

### Content Organization

**Left Pane (Question):**
1. Pre-exam instructions (collapsible alert, expanded by default)
2. Question title with number
3. Markdown content
4. Question attachments list

**Right Pane (Answer):**
1. **Primary**: Drag-and-drop file upload area (visual focus)
2. **Secondary**: Uploaded file cards (deletable)
3. **Tertiary**: Text supplement (collapsible, optional)
4. Submit button

### Interaction Details

**File Upload:**
- Large drag-and-drop zone with clear visual affordance
- Batch upload support
- File type icons and size display
- Individual delete capability

**Auto-save:**
- Automatic draft saving during input
- "Saved at HH:MM" status indicator

**Text Input:**
- Auto-expanding textarea (adaptive height)
- Collapsed by default (file upload is primary)

**Timer:**
- Shows elapsed time (not countdown)
- Subtle styling to avoid pressure

## Visual Design

### Color & Typography

- Clean white background (#ffffff)
- Subtle borders (border-border)
- Primary accent for CTAs (teal #14B8A6)
- Clear typographic hierarchy

### Components

**Top Progress Bar:**
- Fixed height 56px
- Centered progress indicator
- Left: Topic name
- Right: Timer + Navigation buttons

**Instructions Alert:**
- Collapsible card with info icon
- Amber/yellow tint for visibility
- Default expanded, user can collapse

**File Upload Zone:**
- Dashed border when empty
- Solid border on drag hover
- Large upload icon
- Clear text guidance

**File Cards:**
- Horizontal layout with icon
- Filename + size
- Delete button on hover

## Responsive Behavior

| Breakpoint | Layout | Notes |
|------------|--------|-------|
| ≥1024px | 45:55 split | Full desktop experience |
| 768-1023px | 50:50 split | Balanced for tablets |
| <768px | Single column | Stacked layout, touch-optimized |

## Mobile-Specific Adaptations

- Full-width touch targets (min 44px)
- Drawer-style navigation if needed
- Simplified file upload (native file picker)
- Floating submit button for easy access

## Implementation Notes

### Component Structure

```
app/(tasks)/evaluation/respondent/topics/[id]/questions/[qid]/
├── page.tsx              # Router component (dynamic imports)
├── RespondentQuestionDesktop.tsx  # Desktop implementation
└── RespondentQuestionMobile.tsx   # Mobile implementation
```

### Key Dependencies

- Resizable panel library for split-pane
- Existing EvaluationFileUpload component (enhanced)
- EnhancedMarkdown for question rendering
- useIsMobile hook for responsive routing

### State Management

- Auto-save draft to localStorage
- Track upload progress
- Manage collapsible sections

## Success Criteria

1. Users can focus on answering without visual distractions
2. File upload is clearly the primary action
3. Progress and location within question set is clear
4. Mobile experience is equally efficient
5. Professional appearance matches enterprise expectations

## References

- Coding module layout (CodePageDesktop.tsx, CodePageMobile.tsx)
- Wegent design system (AGENTS.md)
- Linear app for clean aesthetics
- Standardized testing platforms for examination feel
