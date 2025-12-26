# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Seed system-level skills (public skills with user_id=0).

This script seeds system-level skills that are available to all users.
Run this script to initialize or update the built-in skills.

Usage:
    python -m app.scripts.seed_skills

Or from the backend directory:
    python seed_skills.py
"""
import logging
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db.session import SessionLocal
from app.services.adapters.public_skill import public_skill_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# System-level skill definitions
SYSTEM_SKILLS = [
    {
        "name": "mermaid-diagram",
        "description": (
            "Use this skill when you need to visualize concepts, workflows, "
            "architectures, or relationships using diagrams. Supports flowchart, "
            "sequence, class, state, ER, gantt, pie, mindmap and more diagram types."
        ),
        "prompt": """# Diagram Visualization with Mermaid

When you need to visualize concepts, workflows, architectures, or relationships, use Mermaid diagram syntax. Wrap your diagram code in a ```mermaid code block.

## Supported Diagram Types

- **flowchart**: Process flows, decision trees, workflows
  - Use `flowchart TD` (top-down) or `flowchart LR` (left-right)
- **sequenceDiagram**: Interaction sequences between components/actors
- **classDiagram**: Class structures and relationships
- **stateDiagram-v2**: State machines and transitions
- **erDiagram**: Entity-relationship diagrams
- **gantt**: Project timelines and schedules
- **pie**: Proportional data distribution
- **mindmap**: Hierarchical idea organization
- **timeline**: Chronological events
- **gitGraph**: Git branch visualizations
- **journey**: User journeys and user flows
- **quadrantChart**: Strategic planning and decision-making

## Syntax Guidelines

1. Always wrap diagram code in ```mermaid code blocks
2. Use clear, descriptive node labels
3. Keep diagrams simple - split complex diagrams into multiple smaller ones
4. Use consistent naming conventions for nodes
5. Avoid special characters in node IDs (use alphanumeric and underscores)

## Examples

### Flowchart
```mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
```

### Sequence Diagram
```mermaid
sequenceDiagram
    participant U as User
    participant S as Server
    participant D as Database
    U->>S: Request
    S->>D: Query
    D-->>S: Result
    S-->>U: Response
```

### Class Diagram
```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +fetch()
    }
    Animal <|-- Dog
```

### State Diagram
```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing: Start
    Processing --> Completed: Success
    Processing --> Error: Failure
    Completed --> [*]
    Error --> Idle: Retry
```

### Entity-Relationship Diagram
```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    PRODUCT ||--o{ LINE-ITEM : "ordered in"
```

### Gantt Chart
```mermaid
gantt
    title Project Timeline
    dateFormat  YYYY-MM-DD
    section Phase 1
    Task A           :a1, 2024-01-01, 30d
    Task B           :after a1, 20d
    section Phase 2
    Task C           :2024-02-01, 15d
```

### Pie Chart
```mermaid
pie title Distribution
    "Category A" : 45
    "Category B" : 30
    "Category C" : 25
```

### Mind Map
```mermaid
mindmap
  root((Main Topic))
    Branch 1
      Leaf 1.1
      Leaf 1.2
    Branch 2
      Leaf 2.1
    Branch 3
```

## Best Practices

- Keep diagrams focused on one concept
- Use meaningful labels and descriptions
- Test that diagrams render correctly
- Consider using subgraphs for complex flowcharts
- Use notes and comments for clarification
- For complex systems, break into multiple diagrams

## Common Issues

1. **Syntax errors**: Check for missing arrows, brackets, or quotes
2. **Large diagrams**: Split into multiple smaller diagrams
3. **Special characters**: Escape or avoid special characters in node IDs
4. **Rendering issues**: Simplify the diagram structure
""",
        "version": "1.0.0",
        "author": "Wegent Team",
        "tags": ["diagram", "visualization", "mermaid"],
    },
]


def seed_system_skills():
    """Seed system-level skills (user_id=0)."""
    db = SessionLocal()
    created = 0
    updated = 0

    try:
        for skill_data in SYSTEM_SKILLS:
            try:
                result = public_skill_service.upsert_skill(
                    db,
                    name=skill_data["name"],
                    description=skill_data["description"],
                    prompt=skill_data.get("prompt"),
                    version=skill_data.get("version"),
                    author=skill_data.get("author"),
                    tags=skill_data.get("tags"),
                )

                # Check if it was created or updated
                if result.get("created_at") == result.get("updated_at"):
                    created += 1
                    logger.info(f"Created system skill: {skill_data['name']}")
                else:
                    updated += 1
                    logger.info(f"Updated system skill: {skill_data['name']}")

            except Exception as e:
                logger.error(f"Failed to seed skill {skill_data['name']}: {e}")

        logger.info(f"Seeding complete: {created} created, {updated} updated")
        return {"created": created, "updated": updated}

    finally:
        db.close()


if __name__ == "__main__":
    seed_system_skills()
