---
sidebar_position: 6
---

# Smart Follow-up Mode

Smart Follow-up Mode is an intelligent feature in Wegent that allows AI agents to ask questions before executing tasks, confirming requirement details to provide more accurate responses.

---

## 📋 Table of Contents

- [What is Smart Follow-up Mode](#-what-is-smart-follow-up-mode)
- [Enabling Smart Follow-up Mode](#-enabling-smart-follow-up-mode)
- [Question Types](#-question-types)
- [Answering Questions](#-answering-questions)
- [Use Cases](#-use-cases)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)

---

## 💬 What is Smart Follow-up Mode

Smart Follow-up Mode is an interactive requirement confirmation mechanism. When enabled, the AI agent analyzes user requirements before execution, identifies areas that may be ambiguous or need more information, and then asks structured questions to confirm with the user.

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

## 🚀 Enabling Smart Follow-up Mode

### Method 1: Click the Follow-up Button

1. Find the **follow-up icon** (💬 question bubble) in the chat input area
2. Click the icon to enable smart follow-up mode
3. The icon highlights when enabled
4. Click again to disable

### Method 2: Enable When Sending Messages

Smart follow-up mode takes effect when sending messages:

1. Enable smart follow-up mode
2. Enter your requirements
3. Send the message
4. AI will return follow-up questions instead of executing directly

### Status Indicators

| Status | Icon Style | Description |
|--------|------------|-------------|
| **Off** | Default border | Smart follow-up mode not enabled |
| **On** | Theme color highlight | Smart follow-up mode enabled |
| **Disabled** | Gray | Loading or streaming in progress |

---

## 📝 Question Types

AI agents generate different types of follow-up questions based on requirements:

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

### Follow-up Form Interface

When AI returns follow-up questions, a structured form is displayed:

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

**Follow-up Questions**:
- What is the report topic?
- Who is the target audience?
- What is the length requirement?
- What sections should be included?

### Case 2: Multiple Implementation Options

When tasks have multiple possible implementations:

**User Input**: "Help me analyze this data"

**Follow-up Questions**:
- What type of analysis do you want? (Descriptive/Predictive/Diagnostic)
- Output format preference? (Table/Chart/Text)
- Do you need statistical tests?

### Case 3: Technical Choices

When technical choices are involved:

**User Input**: "Help me build a website"

**Follow-up Questions**:
- What is the main purpose of the website?
- Do you need user login functionality?
- Expected traffic level?
- Any specific technology stack preferences?

### Case 4: Constraints

When understanding limitations is needed:

**User Input**: "Help me create a plan"

**Follow-up Questions**:
- What is the time frame?
- Available resources/budget?
- What constraints must be met?
- Priority ranking?

---

## ✨ Best Practices

### 1. When to Enable Smart Follow-up Mode

**Recommended to Enable**:
- Complex or multi-step tasks
- Brief requirement descriptions
- Multiple possible implementations
- Need to clarify constraints

**Can Skip**:
- Simple, clear questions
- Already provided detailed requirements
- Quick Q&A scenarios

### 2. How to Answer Follow-up Questions

- **Read Carefully**: Understand each question's meaning
- **Choose Recommended**: If unsure, select recommended options
- **Add Notes**: Use the notes box to provide extra context
- **Stay Consistent**: Keep answers logically consistent

### 3. Improving Follow-up Effectiveness

- **Initial Description**: Even with smart follow-up mode, provide clear initial descriptions
- **Key Information**: Include key constraints and preferences in initial message
- **Iterative Optimization**: Adjust future requirement descriptions based on AI questions

---

## ⚠️ Common Issues

### Q1: Does smart follow-up mode increase response time?

**Answer**: Yes, smart follow-up mode adds one round of interaction. However, this usually reduces subsequent modifications and communication, potentially being more efficient overall.

### Q2: Can I skip follow-up questions and execute directly?

**Answer**: Follow-up questions must be answered to continue. If you don't want to answer, disable smart follow-up mode and resend the message.

### Q3: Is there a limit on the number of follow-up questions?

**Answer**: AI generates an appropriate number of questions based on requirement complexity, typically 3-5 questions.

### Q4: Can I modify answers after submission?

**Answer**: Cannot modify after submission. If changes are needed, explain in subsequent conversation.

### Q5: Which agents support smart follow-up mode?

**Answer**: Smart follow-up mode currently only supports Chat Shell type agents.

### Q6: Why are some questions required?

**Answer**: Single choice questions need explicit selection to continue, ensuring AI has sufficient information to execute the task.

---

## 🔗 Related Resources

- [Creating Conversations](./managing-tasks.md) - Learn how to create conversations
- [AI Cross-Validation](./correction-mode-guide.md) - Learn about AI cross-validation
- [Agent Settings](../settings/agent-settings.md) - Configure agents

---

<p align="center">Use Smart Follow-up Mode to help AI better understand your needs! 💬</p>
