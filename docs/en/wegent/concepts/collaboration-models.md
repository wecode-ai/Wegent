---
sidebar_position: 4
---

# Collaboration Models

This document introduces the four collaboration models in Wegent, helping you choose the most suitable pattern for building your agent teams.

---

## Collaboration Models Overview

Collaboration models define how multiple Bots interact and work together within a Team. Choosing the right collaboration model can significantly improve team efficiency and task completion quality.

### Four Collaboration Models

| Model | Icon | Characteristics | Use Cases |
|-------|------|-----------------|-----------|
| **Pipeline** | 🔄 | Sequential execution, linear flow | Code development workflow, content production pipeline |
| **Route** | 🎯 | Intelligent routing, on-demand assignment | Customer service, problem classification |
| **Coordinate** | 👥 | Parallel coordination, result aggregation | Multi-perspective analysis, parallel task processing |
| **Collaborate** | 💬 | Free collaboration, shared context | Brainstorming, complex problem solving |

### Selection Decision Tree

```
Start Model Selection
    │
    ├── Does task have fixed order?
    │   └── Yes → Pipeline (Sequential Model)
    │
    ├── Need content-based task routing?
    │   └── Yes → Route (Routing Model)
    │
    ├── Can tasks be parallelized?
    │   └── Yes → Coordinate (Coordination Model)
    │
    └── Need free discussion?
        └── Yes → Collaborate (Collaboration Model)
```

---

## 🔄 Pipeline

### Overview

Pipeline is the simplest and most intuitive collaboration model. Bots execute sequentially in a predefined order, with each Bot's output becoming the input for the next, forming a complete processing pipeline.

### Workflow

```
Task Input → Bot 1 → Bot 2 → Bot 3 → Bot 4 → Final Result
```

### Core Features

- ✅ **Sequential Execution**: Strictly follows defined order
- ✅ **Data Passing**: Previous Bot's output automatically passes to next
- ✅ **Simple and Clear**: Easy to understand and maintain
- ✅ **Error Isolation**: Failures can be quickly localized

### Use Cases

- **Software Development Workflow**: Requirements Analysis → Design → Implementation → Code Review → Testing
- **Content Production Pipeline**: Content Creation → Editing → Formatting → Quality Review
- **Data Processing Pipeline**: Data Collection → Data Cleaning → Data Transformation → Data Analysis

---

## 🎯 Route

### Overview

Route model uses a Leader Bot to intelligently route tasks to the most suitable expert Bot based on task content. Ideal for scenarios requiring different handling paths based on varying conditions.

### Workflow

```
Task Input → Leader Bot (Routing Decision)
              ├── Frontend Issue → Frontend Bot
              ├── Backend Issue → Backend Bot
              ├── Database Issue → Database Bot
              └── DevOps Issue → DevOps Bot
                      ↓
                   Result
```

### Core Features

- ✅ **Intelligent Routing**: Leader Bot analyzes task and selects best expert
- ✅ **Specialized Roles**: Each Bot focuses on specific domain
- ✅ **Flexible and Efficient**: Dynamically selects execution path based on needs
- ✅ **Extensible**: Easy to add new expert Bots

### Use Cases

- **Intelligent Customer Service**: Customer Question → Classification → Technical Support/After-Sales/Sales
- **Technical Support Platform**: Technical Issue → Analysis → Frontend Expert/Backend Expert/Database Expert
- **Content Distribution System**: Content Submission → Classification → News/Tech/Entertainment Channel

---

## 👥 Coordinate

### Overview

Coordinate model has a Leader Bot decompose tasks and assign them to multiple Bots for parallel processing, then collect and aggregate all Bot results to form the final comprehensive output.

### Workflow

```
Task Input → Leader Bot (Task Decomposition)
              ├── Analyst Bot ──┐
              ├── Data Bot ─────┼→ Leader Bot (Result Aggregation) → Comprehensive Result
              └── Research Bot ─┘
```

### Core Features

- ✅ **Parallel Processing**: Multiple Bots work simultaneously for efficiency
- ✅ **Task Decomposition**: Leader breaks down complex tasks
- ✅ **Result Aggregation**: Leader integrates multiple perspective outputs
- ✅ **Comprehensive and In-depth**: Analyzes problems from multiple angles

### Use Cases

- **Market Research Analysis**: Market Research Task → Competitor Analysis/User Research/Trend Analysis → Comprehensive Report
- **Code Review**: Code Review Task → Security Review/Performance Review/Code Quality → Review Report
- **Content Creation**: Article Topic → Material Collection/Case Study/Data Analysis → Complete Article

---

## 💬 Collaborate

### Overview

Collaborate model allows all Bots to freely discuss and collaborate in a shared context, without fixed execution order or clear role divisions. All Bots can see each other's messages and respond based on the overall conversation.

### Workflow

```
Task Input → Shared Context Space
              ↕        ↕        ↕        ↕
           Bot 1    Bot 2    Bot 3    Bot 4
              └────────┴────────┴────────┘
                         ↓
                Collaborative Output
```

### Core Features

- ✅ **Shared Context**: All Bots see complete conversation history
- ✅ **Free Discussion**: No fixed order, Bots can participate anytime
- ✅ **Collective Intelligence**: Promotes creativity and multi-perspective thinking
- ✅ **Dynamic Interaction**: Bots can respond to others' viewpoints

### Use Cases

- **Brainstorming Sessions**: Creative Topic → Product Manager/Designer/Engineer/Marketing → Creative Solutions
- **Technical Solution Design**: Technical Challenge → Architect/Developer/DBA/DevOps → Technical Solution
- **Complex Problem Diagnosis**: System Issue → Backend/Frontend/DBA/DevOps → Root Cause

---

## Model Comparison

### Feature Comparison Table

| Feature | Pipeline | Route | Coordinate | Collaborate |
|---------|----------|-------|------------|-------------|
| **Execution Order** | Fixed sequence | Dynamic single path | Parallel execution | No fixed order |
| **Bot Interaction** | Unidirectional passing | Leader → Expert | Leader coordination | Full interaction |
| **Context Sharing** | Partial (sequential) | Independent context | Leader aggregation | Fully shared |
| **Team Size** | 3-6 Bots | 1 Leader + N experts | 1 Leader + 3-5 experts | 3-8 Bots |
| **Execution Efficiency** | Medium (serial) | High (single path) | High (parallel) | Medium (discussion) |
| **Ease of Use** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| **Flexibility** | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

### Selection Guide

- **Standardized Process** → Pipeline
- **Need Specialized Division (Single Expert)** → Route
- **Need Specialized Division (Multiple Experts)** → Coordinate
- **Need Free Discussion** → Collaborate

---

## Best Practices

### General Recommendations

1. **Start Simple**: Prefer Pipeline or Route first, avoid over-engineering
2. **Control Team Size**: Each model has recommended Bot count, too many reduces efficiency
3. **Clear Role Definition**: Each Bot's responsibilities should be clear and specific
4. **Design Good Prompts**: Good prompt structure includes role definition, responsibilities, input/output requirements

### Key Points by Model

| Model | Key Points |
|-------|------------|
| **Pipeline** | Control step count (≤6), single responsibility per step |
| **Route** | Clear routing rules, include default handling path |
| **Coordinate** | Leader needs strong aggregation capability, control parallel count (3-5) |
| **Collaborate** | Define clear goals, set discussion termination conditions |

---

## Related Documentation

- [Core Concepts](./core-concepts.md) - Understand Bot, Team, and other core concepts
- [YAML Specification](../reference/yaml-specification.md) - Complete configuration format guide
- [Collaboration Models Development Guide](../developer-guide/collaboration-models-guide.md) - Detailed configuration examples and real-world cases

---

<p align="center">Choosing the right collaboration model is key to success! 🚀</p>
