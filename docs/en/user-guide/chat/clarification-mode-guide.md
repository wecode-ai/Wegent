---
sidebar_position: 6
---

# Clarification Mode

Clarification Mode is an intelligent feature in Wegent that allows AI agents to ask questions before executing tasks, confirming requirement details to provide more accurate responses.

---

## 📋 Table of Contents

- [What is Clarification Mode](#-what-is-clarification-mode)
- [Enabling Clarification Mode](#-enabling-clarification-mode)
- [Question Types](#-question-types)
- [Answering Questions](#-answering-questions)
- [Use Cases](#-use-cases)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)

---

## 💬 What is Clarification Mode

Clarification Mode is an interactive requirement confirmation mechanism. When enabled, the AI agent analyzes user requirements before execution, identifies areas that may be ambiguous or need more information, and then asks structured questions to confirm with the user.

**Workflow**:
```
User sends message → AI analyzes requirements → Generates clarification questions → User answers → AI executes task
```

### Core Benefits

| Benefit | Description |
|---------|-------------|
| **Reduce Misunderstanding** | Confirm requirements before execution to avoid interpretation errors |
| **Improve Efficiency** | Collect all necessary information at once, reducing back-and-forth |
| **Better Results** | Provide more accurate answers based on clear requirements |
| **User Control** | Users can explicitly specify preferences and constraints |

---

## 🚀 Enabling Clarification Mode

### Method 1: Click the Clarification Button

1. Find the **clarification icon** (💬 question bubble) in the chat input area
2. Click the icon to enable clarification mode
3. The icon highlights when enabled
4. Click again to disable

### Method 2: Enable When Sending Messages

Clarification mode takes effect when sending messages:

1. Enable clarification mode
2. Enter your requirements
3. Send the message
4. AI will return clarification questions instead of executing directly

### Status Indicators

| Status | Icon Style | Description |
|--------|------------|-------------|
| **Off** | Default border | Clarification mode not enabled |
| **On** | Theme color highlight | Clarification mode enabled |
| **Disabled** | Gray | Loading or streaming in progress |

---

## 📝 Question Types

AI agents generate different types of clarification questions based on requirements:

### Single Choice

For situations requiring selection of one option from multiple choices:

- Displayed as radio button list
- Only one option can be selected
- Recommended options have special markers
- Click an option to select

### Multiple Choice

For situations where multiple options can be selected:

- Displayed as checkbox list
- Multiple options can be selected
- Recommended options are pre-checked
- Can select no options

### Text Input

For situations requiring free-form user input:

- Displayed as text input box
- Any text can be entered
- Suitable for descriptive answers
- Can be left empty

---

## ✅ Answering Questions

### Clarification Form Interface

When AI returns clarification questions, a structured form is displayed:

1. **Question List**: Each question displayed in a separate card
2. **Options/Input Fields**: Appropriate controls based on question type
3. **Recommended Markers**: Recommended options have special identification
4. **Additional Notes Box**: Extra text box at bottom for supplementary notes
5. **Submit Button**: Click to submit all answers

### Answer Steps

1. **Read Questions**: Carefully read each question's description
2. **Select/Enter Answers**: 
   - Single choice: Click to select one option
   - Multiple choice: Check needed options
   - Text input: Enter answer in input box
3. **Add Supplementary Notes** (optional): Add extra information in bottom input box
4. **Submit Answers**: Click "Submit Answers" button

### View Raw Content

To view the raw Markdown content returned by AI:

1. Click the **"Show Raw"** button in the top right of the form
2. View the raw format question content
3. Click **"Show Form"** to return to form view

### Required Validation

- Single choice questions must have one option selected
- Multiple choice can have no selection (empty selection is valid)
- Text input can be left empty
- Unanswered required questions show red prompts

---

## 🎯 Use Cases

### Case 1: Unclear Requirements

When user requirements are vague:

**User Input**: "Help me write a report"

**Clarification Questions**:
- What is the report topic?
- Who is the target audience?
- What is the length requirement?
- What sections should be included?

### Case 2: Multiple Implementation Options

When tasks have multiple possible implementations:

**User Input**: "Help me analyze this data"

**Clarification Questions**:
- What type of analysis do you want? (Descriptive/Predictive/Diagnostic)
- Output format preference? (Table/Chart/Text)
- Do you need statistical tests?

### Case 3: Technical Choices

When technical choices are involved:

**User Input**: "Help me build a website"

**Clarification Questions**:
- What is the main purpose of the website?
- Do you need user login functionality?
- Expected traffic level?
- Any specific technology stack preferences?

### Case 4: Constraints

When understanding limitations is needed:

**User Input**: "Help me create a plan"

**Clarification Questions**:
- What is the time frame?
- Available resources/budget?
- What constraints must be met?
- Priority ranking?

---

## ✨ Best Practices

### 1. When to Enable Clarification Mode

**Recommended to Enable**:
- Complex or multi-step tasks
- Brief requirement descriptions
- Multiple possible implementations
- Need to clarify constraints

**Can Skip**:
- Simple, clear questions
- Already provided detailed requirements
- Quick Q&A scenarios

### 2. How to Answer Clarification Questions

- **Read Carefully**: Understand each question's meaning
- **Choose Recommended**: If unsure, select recommended options
- **Add Notes**: Use the notes box to provide extra context
- **Stay Consistent**: Keep answers logically consistent

### 3. Improving Clarification Effectiveness

- **Initial Description**: Even with clarification mode, provide clear initial descriptions
- **Key Information**: Include key constraints and preferences in initial message
- **Iterative Optimization**: Adjust future requirement descriptions based on AI questions

---

## ⚠️ Common Issues

### Q1: Does clarification mode increase response time?

**Answer**: Yes, clarification mode adds one round of interaction. However, this usually reduces subsequent modifications and communication, potentially being more efficient overall.

### Q2: Can I skip clarification questions and execute directly?

**Answer**: Clarification questions must be answered to continue. If you don't want to answer, disable clarification mode and resend the message.

### Q3: Is there a limit on the number of clarification questions?

**Answer**: AI generates an appropriate number of questions based on requirement complexity, typically 3-5 questions.

### Q4: Can I modify answers after submission?

**Answer**: Cannot modify after submission. If changes are needed, explain in subsequent conversation.

### Q5: Which agents support clarification mode?

**Answer**: Clarification mode currently only supports Chat Shell type agents.

### Q6: Why are some questions required?

**Answer**: Single choice questions need explicit selection to continue, ensuring AI has sufficient information to execute the task.

---

## 🔗 Related Resources

- [Creating Conversations](./managing-tasks.md) - Learn how to create conversations
- [Correction Mode](./correction-mode-guide.md) - Learn about correction mode
- [Agent Settings](../settings/agent-settings.md) - Configure agents

---

<p align="center">Use Clarification Mode to help AI better understand your needs! 💬</p>
