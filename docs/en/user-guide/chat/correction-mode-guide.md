---
sidebar_position: 7
---

# Correction Mode

Correction Mode is a quality assurance feature in Wegent that uses another AI model to evaluate and correct agent responses, ensuring accuracy, logic, and completeness.

---

## 📋 Table of Contents

- [What is Correction Mode](#-what-is-correction-mode)
- [Enabling Correction Mode](#-enabling-correction-mode)
- [Understanding Evaluation Results](#-understanding-evaluation-results)
- [Applying Corrections](#-applying-corrections)
- [Use Cases](#-use-cases)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)

---

## ✅ What is Correction Mode

Correction Mode is a dual-verification mechanism. When enabled, the system uses another AI model you select to evaluate the agent's response, checking accuracy, logic, and completeness, and providing improvement suggestions when issues are found.

**Workflow**:
```
Agent response → Correction model evaluates → Generates scores and suggestions → Provides improved version → User chooses whether to apply
```

### Core Benefits

| Benefit | Description |
|---------|-------------|
| **Quality Assurance** | Verify response quality through a second model |
| **Error Detection** | Identify factual errors and logical gaps |
| **Improvement Suggestions** | Provide specific correction suggestions |
| **Optional Application** | Users can choose whether to adopt corrections |

---

## 🚀 Enabling Correction Mode

### Step 1: Click the Correction Button

1. Find the **correction icon** (✓ checkmark circle) in the chat input area
2. Click the icon to open the model selection dialog

### Step 2: Select Correction Model

In the popup dialog:

1. **Search Models**: Use the search box to filter models
2. **Browse List**: View available models
3. **Select Model**: Click to select the model for correction
4. **Confirm Selection**: Correction mode is automatically enabled after selection

### Step 3: Confirm Enabled Status

- Correction icon highlights when enabled
- Hover to see the current correction model name
- Click again to disable correction mode

### Model Types

| Type | Description |
|------|-------------|
| **Public Models** | System pre-configured models |
| **User Models** | User-defined custom models |

### State Persistence

- Correction mode settings are saved to local storage
- Settings are automatically restored when switching tasks
- New tasks inherit previous settings

---

## 📊 Understanding Evaluation Results

After the agent responds, the correction model generates evaluation results displayed in a panel below the response.

### Scoring Metrics

The correction model evaluates responses across three dimensions:

| Metric | Description | Score Range |
|--------|-------------|-------------|
| **Accuracy** | Are facts correct | 0-10 |
| **Logic** | Is reasoning sound | 0-10 |
| **Completeness** | Is the answer comprehensive | 0-10 |

### Score Color Indicators

| Score Range | Color | Meaning |
|-------------|-------|---------|
| 8-10 | Green | Excellent |
| 6-7 | Yellow | Good |
| 4-5 | Orange | Needs Improvement |
| 0-3 | Red | Significant Issues |

### Issue List

If issues are found, specific problems and suggestions are displayed:

- **Issue Description**: Points out specific problems in the response
- **Correction Suggestion**: Provides suggestions for improvement
- **Issue Number**: Numbered sequentially for reference

### Improved Version

The correction model generates an improved version of the response:

- Displayed in the main area of the evaluation panel
- Issues found have been corrected
- Maintains the style and structure of the original response

### Summary

A brief summary at the bottom of evaluation results provides an overview of the overall assessment.

---

## ✅ Applying Corrections

### View Improved Version

1. After evaluation completes, the improved version displays at the top of the panel
2. Compare the original response with the improved version
3. Click "Show Evaluation Details" to see specific scores and issues

### Apply Improvements

If you approve the improved version:

1. Hover over the improved version area
2. Click the **"Apply"** button in the top right
3. The improved version replaces the original response
4. Button changes to **"Applied"** status

### Application Status

| Status | Button Display | Description |
|--------|----------------|-------------|
| **Not Applied** | "Apply" | Can click to apply improvement |
| **Applying** | Loading animation | Saving improvement |
| **Applied** | "Applied" ✓ | Improvement has been adopted |

### Re-evaluate

If re-evaluation is needed:

1. Expand evaluation details
2. Click the **"Re-evaluate"** button at the bottom
3. Correction model will re-analyze the response

---

## 🎯 Use Cases

### Case 1: Fact Checking

When responses involve factual information:

- Correction model verifies accuracy of facts
- Identifies possible errors or outdated information
- Provides more accurate information version

### Case 2: Logic Verification

When responses involve reasoning or analysis:

- Checks if reasoning process is sound
- Identifies logical gaps or contradictions
- Provides more rigorous argumentation

### Case 3: Completeness Check

When responses need comprehensive coverage:

- Checks if important aspects are missing
- Identifies content that needs supplementation
- Provides more complete answers

### Case 4: Important Decisions

When responses are used for important decisions:

- Provides a second opinion
- Increases response credibility
- Reduces risk of wrong decisions

---

## ✨ Best Practices

### 1. Choosing the Right Correction Model

**Recommended Strategies**:
- Choose a different model from the main model for different perspectives
- For specialized domains, choose models that perform well in that area
- Consider model speed and cost

### 2. When to Enable Correction Mode

**Recommended to Enable**:
- Responses involving factual information
- Important decision support
- Scenarios requiring high accuracy
- Professional domain Q&A

**Can Skip**:
- Simple creative writing
- Non-critical conversations
- Scenarios requiring fast responses

### 3. How to Use Evaluation Results

- **Check Scores**: Quickly understand response quality
- **Read Issues**: Understand specific improvement points
- **Compare Versions**: Compare original and improved versions
- **Selective Application**: Decide whether to apply based on actual needs

### 4. Combining with Other Features

- **With Clarification Mode**: First clarify requirements, then verify with correction
- **With Knowledge Bases**: Responses based on knowledge bases are easier to verify
- **Iterative Optimization**: Optimize subsequent questions based on correction feedback

---

## ⚠️ Common Issues

### Q1: Does correction mode increase response time?

**Answer**: Yes, correction requires additional model calls, adding some wait time. However, for scenarios requiring high-quality responses, this wait is worthwhile.

### Q2: Is the correction model's evaluation always accurate?

**Answer**: The correction model's evaluation is a reference opinion, not necessarily 100% accurate. It's recommended to combine with your own judgment when deciding whether to adopt.

### Q3: Can I use the same model for correction?

**Answer**: Technically possible, but using a different model is recommended for different perspectives and more effective verification.

### Q4: Can I undo after applying correction?

**Answer**: After application, the original response is replaced and cannot be directly undone. It's recommended to carefully compare both versions before applying.

### Q5: Which agents support correction mode?

**Answer**: Correction mode currently only supports Chat Shell type agents.

### Q6: Are correction settings saved?

**Answer**: Yes, correction mode settings (including selected model) are saved to local storage and automatically restored when accessing the same task next time.

### Q7: Why is there sometimes no improved version?

**Answer**: If the correction model determines the original response is good enough, it may not generate an improved version, only showing scores and a "no correction needed" message.

---

## 🔗 Related Resources

- [Creating Conversations](./managing-tasks.md) - Learn how to create conversations
- [Clarification Mode](./clarification-mode-guide.md) - Learn about clarification mode
- [Configuring Models](../settings/configuring-models.md) - Add and configure models

---

<p align="center">Use Correction Mode to ensure AI response quality! ✅</p>
