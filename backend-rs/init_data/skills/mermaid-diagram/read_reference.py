# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tool for reading Mermaid diagram references."""

from typing import Optional, Type

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

MERMAID_REFERENCES = {
    "architecture.md": """# Architecture Diagram

Architecture diagrams visualize relationships between services and resources (Cloud, CI/CD).

## Syntax

Defined using `architecture-beta`.

### Components

```mermaid
architecture-beta
    group <id>(<icon>)[<label>]
    service <id>(<icon>)[<label>] in <groupId>
    junction <id>
```

- **Icons:** `cloud`, `database`, `disk`, `internet`, `server` or `logos:<icon-name>` (from Iconify).

### Edges

Connect specific sides of services: `L` (Left), `R` (Right), `T` (Top), `B` (Bottom).

```
<id>:<side> -- <side>:<id>
<id>:<side> --> <side>:<id>
```

## Example

```mermaid-example
architecture-beta
    group api(cloud)[API]

    service db(database)[Database] in api
    service disk1(disk)[Storage] in api
    service disk2(disk)[Storage] in api
    service server(server)[Server] in api
    service gateway(internet)[Gateway]

    db:L -- R:server
    disk1:T -- B:server
    disk2:T -- B:db
    server:T -- B:gateway
```""",
    "block.md": """# Block Diagram

Block diagrams provide a high-level view of a system, giving the author full control over positioning using columns.

## Syntax

### Layout

Define the number of columns to arrange blocks.

```mermaid
block
  columns <number>
  <block1> <block2> ...
```

### Block Definitions

- **Simple:** `id` or `id["Label"]`
- **Spanning:** `id:width` (e.g., `block:2` spans 2 columns).
- **Spacing:** `space` or `space:width`.
- **Nested:**
  ```mermaid
  block:groupName
    columns 1
    item1 item2
  end
  ```

### Shapes

| Shape         | Syntax          | Shape          | Syntax          |
| :------------ | :-------------- | :------------- | :-------------- |
| **Square**    | `id`            | **Round Edge** | `id("Label")`   |
| **Stadium**   | `id(["Label"])` | **Subroutine** | `id[["Label"]]` |
| **Cylinder**  | `id[("Label")]` | **Circle**     | `id(("Label"))` |
| **Diamond**   | `id{"Label"}`   | **Hexagon**    | `id{{"Label"}}` |
| **Trapezoid** | `id[/"Label"\\]` | **Inv. Trap.** | `id[\\"Label"/]` |

### Edges

- `id1 --> id2`
- `id1 -- "Label" --> id2`
- **Block Arrows:** `arrowId<["Label"]>(direction)` (up, down, left, right)

## Example

```mermaid-example
block
  columns 3

  frontend("Frontend") blockArrowId6<["JSON"]>(right) backend("Backend")
  space:2 down<["Load"]>(down)

  disk("Storage") left<["Read/Write"]>(left) db[("Database")]

  classDef front fill:#696,stroke:#333;
  classDef back fill:#969,stroke:#333;
  class frontend front
  class backend,db back
```""",
    "c4.md": """# C4 Diagrams

C4 diagrams visualize software architecture at different levels of detail (System Context, Container, Component).

## Syntax

C4 diagrams in Mermaid use `C4Context`, `C4Container`, `C4Component`, `C4Dynamic` or `C4Deployment`.

### Core Elements

*   **Person:** `Person(alias, "Label", "Description")`
*   **System:** `System(alias, "Label", "Description")`
*   **System_Ext:** `System_Ext(alias, "Label", "Description")`
*   **Container:** `Container(alias, "Label", "Technology", "Description")`
*   **Component:** `Component(alias, "Label", "Technology", "Description")`
*   **Database:** `SystemDb(...)`, `ContainerDb(...)`, `ComponentDb(...)`

### Boundaries

```mermaid
Boundary(alias, "Label") {
    ...
}
```

Types: `Enterprise_Boundary`, `System_Boundary`, `Container_Boundary`.

### Relationships

*   **Rel:** `Rel(from, to, "Label", "Technology")`
*   **BiRel:** `BiRel(from, to, "Label")`

## Example (Container Diagram)

```mermaid-example
C4Container
    title Container diagram for Internet Banking System

    Person(customer, "Customer", "A customer of the bank, with personal bank accounts")

    System_Boundary(c1, "Internet Banking") {
        Container(web_app, "Web Application", "Java, Spring MVC", "Delivers the static content and the Internet banking SPA")
        Container(spa, "Single-Page App", "JavaScript, Angular", "Provides all the Internet banking functionality to customers via their web browser")
        ContainerDb(database, "Database", "SQL Database", "Stores user registration information, hashed auth credentials, access logs, etc.")
        ContainerDb_Ext(backend_api, "API Application", "Java, Docker Container", "Provides Internet banking functionality via API")
    }

    System_Ext(email_system, "E-Mail System", "The internal Microsoft Exchange system")
    System_Ext(banking_system, "Mainframe Banking System", "Stores all of the core banking information about customers, accounts, transactions, etc.")

    Rel(customer, web_app, "Uses", "HTTPS")
    Rel(customer, spa, "Uses", "HTTPS")
    
    Rel(web_app, spa, "Delivers")
    Rel(spa, backend_api, "Uses", "async, JSON/HTTPS")
    Rel(backend_api, database, "Reads from and writes to", "sync, JDBC")
    
    Rel(email_system, customer, "Sends e-mails to")
    Rel(backend_api, email_system, "Sends e-mails using", "sync, SMTP")
    Rel(backend_api, banking_system, "Uses", "sync/async, XML/HTTPS")
```""",
    "classDiagram.md": """# Class Diagram

Class diagrams describe the structure of a system by showing the system's classes, their attributes, operations (or methods), and the relationships among objects.

## Syntax

### Class Definition

```mermaid
classDiagram
    class BankAccount
    class Animal["Animal with Label"]
```

### Members

- **Attribute:** `+String owner`, `-int id`
- **Method:** `+deposit(amount)`, `-check()`
- **Visibility:** `+` (Public), `-` (Private), `#` (Protected), `~` (Package/Internal)

```mermaid
classDiagram
    class BankAccount {
        +String owner
        +BigDecimal balance
        +deposit(amount)
        +withdrawal(amount)
    }
```

### Relationships

| Type            | Syntax  | Type            | Syntax  |
| :-------------- | :------ | :-------------- | :------ |
| **Inheritance** | `<|--` | **Composition** | `*--`   |
| **Aggregation** | `o--`   | **Association** | `-->`   |
| **Dependency**  | `..>`   | **Realization** | `..|>` |
| **Solid Link**  | `--`    | **Dashed Link** | `..`    |

### Multiplicity

Place multiplicity in quotes before or after the arrow.

```
Customer "1" --> "*" Ticket
```

### Annotations

`<<Interface>>`, `<<Abstract>>`, `<<Service>>`, `<<Enumeration>>`.

```mermaid
classDiagram
    class Shape {
        <<interface>>
        draw()
    }
```

## Example

```mermaid-example
classDiagram
    note "From Duck till Zebra"
    Animal <|-- Duck
    note for Duck "can fly\ncan swim\ncan dive\ncan help in debugging"
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    Animal: +mate()
    class Duck{
        +String beakColor
        +swim()
        +quack()
    }
    class Fish{
        -int sizeInFeet
        -canEat()
    }
    class Zebra{
        +bool is_wild
        +run()
    }
```""",
    "erDiagram.md": """# ER Diagram

Entity Relationship Diagrams (ER) describe interrelated things of interest in a specific domain of knowledge.

## Syntax

```mermaid
erDiagram
    ENTITY1 ||--o{ ENTITY2 : label
```

### Cardinality

| Value  | Meaning     | Value | Meaning      |
| :----: | :---------- | :---: | :----------- |
| `|o`  | Zero or one | `}o`  | Zero or more |
| `||` | Exactly one | `}|` | One or more  |

### Relationships

- **Identifying:** `--` (Solid line, cannot exist without the other)
- **Non-Identifying:** `..` (Dashed line)

### Attributes

Define type, name, and optional keys/comments.

- **Keys:** `PK` (Primary Key), `FK` (Foreign Key), `UK` (Unique Key)
- **Comments:** `"comment string"`

```mermaid
erDiagram
    CAR {
        string registrationNumber PK
        string make
        string model
    }
```

## Example

```mermaid-example
erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
        string name
        string custNumber
        string sector
    }
    ORDER ||--|{ LINE-ITEM : contains
    ORDER {
        int orderNumber
        string deliveryAddress
    }
    LINE-ITEM {
        string productCode
        int quantity
        float pricePerUnit
    }
```""",
    "examples.md": """# Examples

This page contains a collection of examples of diagrams and charts that can be created through mermaid and its myriad applications.

**If you wish to learn how to support mermaid on your webpage, read the [Beginner's Guide](../config/usage.md?id=usage).**

**If you wish to learn about mermaid's syntax, Read the [Diagram Syntax](../references/flowchart.md?id=flowcharts-basic-syntax) section.**

## Basic Pie Chart

```mermaid-example
pie title NETFLIX
         "Time spent looking for movie" : 90
         "Time spent watching it" : 10
```

```mermaid-example
pie title What Voldemort doesn't have?
         "FRIENDS" : 2
         "FAMILY" : 3
         "NOSE" : 45
```

## Basic sequence diagram

```mermaid-example
sequenceDiagram
    Alice ->> Bob: Hello Bob, how are you?
    Bob-->>John: How about you John?
    Bob--x Alice: I am good thanks!
    Bob-x John: I am good thanks!
    Note right of John: Bob thinks a long<br/>long time, so long<br/>that the text does<br/>not fit on a row.

    Bob-->Alice: Checking with John...
    Alice->John: Yes... John, how are you?
```

## Basic flowchart

```mermaid-example
graph LR
    A[Square Rect] -- Link text --> B((Circle))
    A --> C(Round Rect)
    B --> D{Rhombus}
    C --> D
```

## Larger flowchart with some styling

```mermaid-example
graph TB
    sq[Square shape] --> ci((Circle shape))

    subgraph A
        od>Odd shape]-- Two line<br/>edge comment --> ro
        di{Diamond with <br/> line break} -.-> ro(Rounded<br>square<br>shape)
        di==>ro2(Rounded square shape)
    end

    %% Notice that no text in shape are added here instead that is appended further down
    e --> od3>Really long text with linebreak<br>in an Odd shape]

    %% Comments after double percent signs
    e((Inner / circle<br>and some odd <br>special characters)) --> f(,.?!+-*ز)

    cyr[Cyrillic]-->cyr2((Circle shape Начало));

     classDef green fill:#9f6,stroke:#333,stroke-width:2px;
     classDef orange fill:#f96,stroke:#333,stroke-width:4px;
     class sq,e green
     class di orange
```

## SequenceDiagram: Loops, alt and opt

```mermaid-example
sequenceDiagram
    loop Daily query
        Alice->>Bob: Hello Bob, how are you?
        alt is sick
            Bob->>Alice: Not so good :(
        else is well
            Bob->>Alice: Feeling fresh like a daisy
        end

        opt Extra response
            Bob->>Alice: Thanks for asking
        end
    end
```

## SequenceDiagram: Message to self in loop

```mermaid-example
sequenceDiagram
    participant Alice
    participant Bob
    Alice->>John: Hello John, how are you?
    loop HealthCheck
        John->>John: Fight against hypochondria
    end
    Note right of John: Rational thoughts<br/>prevail...
    John-->>Alice: Great!
    John->>Bob: How about you?
    Bob-->>John: Jolly good!
```

## Sequence Diagram: Blogging app service communication

```mermaid-example
sequenceDiagram
    participant web as Web Browser
    participant blog as Blog Service
    participant account as Account Service
    participant mail as Mail Service
    participant db as Storage

    Note over web,db: The user must be logged in to submit blog posts
    web->>+account: Logs in using credentials
    account->>db: Query stored accounts
    db->>account: Respond with query result

    alt Credentials not found
        account->>web: Invalid credentials
    else Credentials found
        account->>-web: Successfully logged in

        Note over web,db: When the user is authenticated, they can now submit new posts
        web->>+blog: Submit new post
        blog->>db: Store post data

        par Notifications
            blog--)mail: Send mail to blog subscribers
            blog--)db: Store in-site notifications
        and Response
            blog-->>-web: Successfully posted
        end
    end

```

## A commit flow diagram.

```mermaid-example
gitGraph:
    commit "Ashish"
    branch newbranch
    checkout newbranch
    commit id:"1111"
    commit tag:"test"
    checkout main
    commit type: HIGHLIGHT
    commit
    merge newbranch
    commit
    branch b2
    commit
```""",
    "flowchart.md": """# Flowchart

Flowcharts use nodes (shapes) and edges (arrows) to visualize processes or workflows.

## Syntax

### Direction

`TB` (Top-Bottom), `TD` (Top-Down), `BT` (Bottom-Top), `RL` (Right-Left), `LR` (Left-Right).

```mermaid
flowchart TD
    Start --> Stop
```

### Nodes

- **Default:** `id`
- **Text:** `id["Label"]`
- **Round:** `id("Label")`
- **Stadium:** `id(["Label"])`
- **Subroutine:** `id[["Label"]]`
- **Database:** `id[("Label")]`
- **Circle:** `id(("Label"))`
- **Rhombus:** `id{"Label"}`
- **Hexagon:** `id{{"Label"}}`
- **Trapezoid:** `id[/"Label"\\]`
- **Inv. Trapezoid:** `id[\\"Label"/]`

### Edges

- **Arrow:** `-->`
- **Open:** `---`
- **Text:** `-- "Label" -->` or `-->|Label|`
- **Dotted:** `-.->`
- **Thick:** `==>`

### Subgraphs

```mermaid
flowchart TB
    subgraph one
    a1-->a2
    end
```

## Example

```mermaid-example
flowchart TD
    A[Start] --> B{Is it?}
    B -- Yes --> C[OK]
    C --> D[Rethink]
    D --> B
    B -- No ----> E[End]
```""",
    "gantt.md": """# Gantt Diagrams

Gantt charts illustrate project schedules.

## Syntax

```mermaid-example
gantt
    dateFormat  YYYY-MM-DD
    title       Project Schedule
    excludes    weekends

    section Section A
    Completed task            :done,    des1, 2024-01-06, 2024-01-08
    Active task               :active,  des2, 2024-01-09, 3d
    Future task               :         des3, after des2, 5d

    section Critical Path
    Critical task             :crit, done, 2024-01-06, 24h
    Dependent task            :crit, active, 3d
    Milestone                 :milestone, m1, 2024-01-25, 0d
```

### Task Syntax

`Task Name : [tags], [id], [startDate], [endDate/duration]`

*   **Tags:** `active`, `done`, `crit`, `milestone`
*   **Time:** `YYYY-MM-DD`, `3d` (days), `2w` (weeks), `after <id>`

### Settings

*   **dateFormat:** `YYYY-MM-DD` (Input format)
*   **axisFormat:** `%Y-%m-%d` (Display format)
*   **excludes:** `weekends`, `sunday`

## Advanced Features

### Compact Mode

```mermaid
---
displayMode: compact
---
gantt
    title Compact Gantt
    dateFormat  YYYY-MM-DD
    section Tasks
    Task A :a1, 2024-01-01, 30d
    Task B :a2, 2024-01-20, 25d
```

### Milestones & Markers

```mermaid
gantt
    dateFormat HH:mm
    axisFormat %H:%M
    Milestone    : milestone, m1, 17:49, 0m
    Vertical Line: vert, v1, 17:30, 0m
```""",
    "gitgraph.md": """# Gitgraph Diagram

Git Graph is a pictorial representation of git commits and git actions on various branches.

## Syntax

```mermaid
gitGraph
   commit
   branch <name>
   checkout <name>
   merge <name>
```

### Commit

- **Default:** `commit`
- **Custom ID:** `commit id: "id"`
- **Type:** `commit type: NORMAL | REVERSE | HIGHLIGHT`
- **Tag:** `commit tag: "v1.0.0"`

### Branching

- **Create:** `branch <name>`
- **Checkout:** `checkout <name>`
- **Merge:** `merge <name>`
- **Cherry Pick:** `cherry-pick id: "id"`

## Example

```mermaid-example
gitGraph
   commit
   commit
   branch develop
   checkout develop
   commit
   commit
   checkout main
   merge develop
   commit
   commit
```""",
    "journey.md": """# User Journey Diagram

User journeys describe the steps different users take to complete a specific task.

## Syntax

### Basic Syntax

Start with `journey`. Define title, sections, and tasks.
Task syntax: `Task name: <score>: <comma separated list of actors>`
Score: 1-5 (5 is best).

```mermaid
journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me
```

## Comprehensive Example

```mermaid
journey
    title E-commerce Checkout Experience
    section Browsing
      Search for product: 5: User
      View details: 4: User
      Add to cart: 5: User
    section Checkout
      Login: 3: User
      Enter shipping info: 2: User
      Payment: 1: User, System
    section Post-Purchase
      Receive confirmation: 5: User
```""",
    "kanban.md": """# Kanban Diagram

A Kanban diagram visually represents tasks moving through different stages of a workflow.

## Syntax

```mermaid-example
kanban
  columnId[Column Title]
    taskId[Task Description]
    taskId2[Task Description]@{ key: value }
```

- **Columns**: Defined by `id[Title]`.
- **Tasks**: Indented under columns. Defined by `id[Description]`.
- **Metadata**: Added with `@{ key: value }`. Common keys: `assigned`, `ticket`, `priority`.

## Example

```mermaid-example
---
config:
  kanban:
    ticketBaseUrl: 'https://jira.example.com/browse/#TICKET#'
---
kanban
  todo[Todo]
    id1[Create Documentation]
    id2[Define API]@{ ticket: MC-2037, assigned: 'alice', priority: 'High' }

  inprogress[In Progress]
    id3[Develop Backend]@{ priority: 'Normal' }

  done[Done]
    id4[Design Review]@{ assigned: 'bob' }
```""",
    "mindmap.md": """# Mindmap Diagram

A mind map organizes information into a hierarchy around a central concept.

## Syntax

Mindmaps rely on indentation for hierarchy.

```mermaid-example
mindmap
  Root
    Level 1
      Level 2
    Level 1
```

### Shapes

Nodes can have different shapes using syntax similar to flowcharts.

- Square: `id[Text]`
- Rounded Square: `id(Text)`
- Circle: `id((Text))`
- Bang: `id))Text((`
- Cloud: `id)Text(`
- Hexagon: `id{{Text}}`

### Icons and Classes

- **Icons**: `::icon(class-name)`
- **Classes**: `:::class-name`

## Example

```mermaid-example
mindmap
  root((Mindmap Root))
    Origins
      Long history
      ::icon(fa fa-book)
      Popularisation
        British popular psychology author Tony Buzan
    Research
      On effectiveness<br/>and features
      On Automatic creation
        Uses
            Creative techniques
            Strategic planning
            Argument mapping
    Tools
      Pen and paper
      Mermaid
```""",
    "packet.md": """# Packet Diagram

A packet diagram illustrates the structure and contents of a network packet.

## Syntax

Use `start-end` ranges or `+length` to define fields.

```mermaid-example
packet
  0-15: "Field A"
  16-31: "Field B"
  +32: "Field C (Next 32 bits)"
```

## Example

```mermaid-example
packet
  title TCP Packet
  0-15: "Source Port"
  16-31: "Destination Port"
  32-63: "Sequence Number"
  64-95: "Acknowledgment Number"
  96-99: "Data Offset"
  100-105: "Reserved"
  106: "URG"
  107: "ACK"
  108: "PSH"
  109: "RST"
  110: "SYN"
  111: "FIN"
  112-127: "Window"
  128-143: "Checksum"
  144-159: "Urgent Pointer"
  160-191: "(Options and Padding)"
  192-255: "Data (variable length)"
```""",
    "pie.md": """# Pie Chart

A pie chart is a circular statistical graphic divided into slices to illustrate numerical proportion.

## Syntax

- Start with `pie`.
- Optional: `showData` to display values.
- Optional: `title` string.
- Data points: `"Label" : Value` (Value must be positive).

```mermaid-example
pie showData
    title Pie Chart Title
    "Label 1" : 40
    "Label 2" : 60
```

## Example

```mermaid-example
pie showData
    title Key elements in Product X
    "Calcium" : 42.96
    "Potassium" : 50.05
    "Magnesium" : 10.01
    "Iron" :  5
```""",
    "quadrantChart.md": """# Quadrant Chart

A quadrant chart plots data on a 2D grid divided into four quadrants, useful for prioritizing actions or analyzing trends.

## Syntax

```mermaid-example
quadrantChart
    title Chart Title
    x-axis Left Text --> Right Text
    y-axis Bottom Text --> Top Text
    quadrant-1 Top Right Text
    quadrant-2 Top Left Text
    quadrant-3 Bottom Left Text
    quadrant-4 Bottom Right Text
    Point A: [x, y]
    Point B: [x, y]
```

- **Axes**: Defined with `x-axis` and `y-axis`. Use `-->` to separate start/end labels.
- **Quadrants**: `quadrant-1` (top-right), `quadrant-2` (top-left), `quadrant-3` (bottom-left), `quadrant-4` (bottom-right).
- **Points**: `Label: [x, y]` where x and y are between 0 and 1.

## Styling

Points can be styled directly or using classes.

```mermaid-example
quadrantChart
  Point A: [0.3, 0.6] radius: 10, color: #ff0000
  Point B:::className: [0.4, 0.8]
  classDef className color: blue, radius: 5
```

## Example

```mermaid-example
quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]
    Campaign E: [0.40, 0.34]
    Campaign F: [0.35, 0.78]
```""",
    "radar.md": """# Radar Diagram

A radar diagram (or spider chart) plots multivariate data in a circular format.

## Syntax

```mermaid-example
radar-beta
  title Chart Title
  axis id1["Label1"], id2["Label2"], id3["Label3"]
  axis id4["Label4"], id5["Label5"], id6["Label6"]
  curve curveId1["Series 1"]{val1, val2, val3, val4, val5, val6}
  curve curveId2["Series 2"]{val1, val2, val3, val4, val5, val6}
  max 100
  min 0
```

- **Title (optional)**: `title Chart Title`
- **Axis**: Define axes using `axis id["Label"], id2["Label2"]...`
  - Can be defined in multiple lines
  - Each axis needs an ID and a label in quotes
  - Axes are separated by commas
- **Curve**: Define data series using `curve id["Name"]{val1, val2, val3...}`
  - Each curve needs an ID and a name in quotes
  - Values are in curly braces, separated by commas
  - Number of values must match the number of axes
- **Max/Min (optional)**: `max 100` and `min 0` to set the scale

## Example

```mermaid-example
radar-beta
  title Student Performance
  axis m["Math"], s["Science"], e["English"]
  axis h["History"], g["Geography"], a["Art"]
  curve alice["Alice"]{85, 90, 80, 70, 75, 90}
  curve bob["Bob"]{70, 75, 85, 80, 90, 85}
  max 100
  min 0
```""",
    "requirementDiagram.md": """# Requirement Diagram

A Requirement diagram visualizes requirements and their relationships, following SysML standards.

## Syntax

```mermaid-example
requirementDiagram
    requirement name {
        id: 1
        text: description
        risk: Low
        verifymethod: Test
    }

    element name {
        type: simulation
        docRef: reference
    }

    src - type -> dst
```

### Properties

- **Type**: `requirement`, `functionalRequirement`, `interfaceRequirement`, `performanceRequirement`, `physicalRequirement`, `designConstraint`.
- **Risk**: `Low`, `Medium`, `High`.
- **VerificationMethod**: `Analysis`, `Inspection`, `Test`, `Demonstration`.
- **Relationships**: `contains`, `copies`, `derives`, `satisfies`, `verifies`, `refines`, `traces`.

## Example

```mermaid-example
requirementDiagram
    requirement test_req {
        id: 1
        text: the test text.
        risk: high
        verifymethod: test
    }

    functionalRequirement test_req2 {
        id: 1.1
        text: the second test text.
        risk: low
        verifymethod: inspection
    }

    element test_entity {
        type: simulation
    }

    test_entity - satisfies -> test_req2
    test_req - traces -> test_req2
```""",
    "sankey.md": """# Sankey Diagram

A Sankey diagram depicts a flow from one set of values to another.

## Syntax

Sankey diagrams uses CSV-like syntax: `source,target,value`.

```mermaid-example
sankey-beta
    source,target,value
    source,target,value
```

## Example

```mermaid-example
sankey-beta
    Agricultural 'waste',Bio-conversion,124.729
    Bio-conversion,Liquid,0.597
    Bio-conversion,Losses,26.862
    Bio-conversion,Solid,280.322
    Bio-conversion,Gas,81.144
    Biofuel imports,Liquid,35
    Biomass imports,Solid,35
```""",
    "sequenceDiagram.md": """# Sequence Diagram

A Sequence diagram is an interaction diagram that shows how processes operate with one another and in what order.

## Syntax

### Participants & Actors

Participants are rendered in order of appearance.

```mermaid
sequenceDiagram
    participant Alice
    participant Bob
    actor John
    Alice->>Bob: Hi Bob
    Bob->>Alice: Hi Alice
    John->>Alice: Hi Alice
```

### Participant Types

Different shapes can be used for participants (v11+).

```mermaid
sequenceDiagram
    participant A@{ "type": "boundary" }
    participant B@{ "type": "control" }
    participant C@{ "type": "entity" }
    participant D@{ "type": "database" }
    participant E@{ "type": "queue" }
```

### Aliases

```mermaid
sequenceDiagram
    participant A as Alice
    participant J as John
    A->>J: Hello John
```

### Messages

| Type  | Description | Type   | Description  |
| ----- | ----------- | ------ | ------------ |
| `->`  | Solid line  | `-->`  | Dotted line  |
| `->>` | Solid arrow | `-->>` | Dotted arrow |
| `-x`  | Solid cross | `--x`  | Dotted cross |
| `-)`  | Async solid | `--)`  | Async dotted |

### Activations

Activate/deactivate actors to show when they are active.

```mermaid
sequenceDiagram
    Alice->>John: Hello John, how are you?
    activate John
    John-->>Alice: Great!
    deactivate John
    Alice->>+John: Hello John, how are you?
    John-->>-Alice: Great!
```

### Notes

```mermaid
sequenceDiagram
    participant John
    Note right of John: Text in note
    Note over Alice,John: A typical interaction
```

### Control Structures

Loop, Alt, Opt, Par, Critical, Break.

```mermaid
sequenceDiagram
    loop Every minute
        John-->Alice: Great!
    end
    alt is sick
        Bob->>Alice: Not so good :(
    else is well
        Bob->>Alice: Feeling fresh like a daisy
    end
    opt Extra response
        Bob->>Alice: Thanks for asking
    end
    par Alice to Bob
        Alice->>Bob: Hello guys!
    and Alice to John
        Alice->>John: Hello guys!
    end
```

### Background Highlighting

```mermaid
sequenceDiagram
    rect rgb(191, 223, 255)
    note right of Alice: Alice calls John.
    Alice->>+John: Hello John, how are you?
    end
```

### Grouping / Box

```mermaid
sequenceDiagram
    box Purple Alice & John
    participant A
    participant J
    end
    box Another Group
    participant B
    participant C
    end
    A->>J: Hello John, how are you?
```

## Comprehensive Example

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant API
    participant DB

    box "Internal System" #f9f9f9
        participant API
        participant DB
    end

    Client->>API: Request Data
    activate API

    alt Cache Hit
        API-->>Client: Return Cached Data
    else Cache Miss
        API->>DB: Query Data
        activate DB
        DB-->>API: Return Result
        deactivate DB

        loop Processing
            API->>API: Process Data
        end

        API-->>Client: Return Fresh Data
    end
    deactivate API

    opt Logging
        API-)DB: Async Log
    end
```""",
    "stateDiagram.md": """# State Diagram

A state diagram describes the behavior of systems by showing states and transitions.

## Syntax

### States

States can be declared by ID or with a description.

```mermaid
stateDiagram-v2
    s1
    state "Description with spaces" as s2
    s3 : Description with colon
```

### Transitions

Transitions are arrows showing state changes.

```mermaid
stateDiagram-v2
    s1 --> s2
    s2 --> s3: Transition label
```

### Start and End

Special states `[*]` denote start and end.

```mermaid
stateDiagram-v2
    [*] --> s1
    s1 --> [*]
```

### Composite States

States can contain other states.

```mermaid
stateDiagram-v2
    state Composite {
        [*] --> Inner1
        Inner1 --> Inner2
    }
```

### Choice

Model a choice between paths.

```mermaid
stateDiagram-v2
    state if_state <<choice>>
    [*] --> if_state
    if_state --> IsTrue : if n >= 0
    if_state --> IsFalse : if n < 0
```

### Fork and Join

Split into parallel states and join them back.

```mermaid
stateDiagram-v2
    state fork_state <<fork>>
    state join_state <<join>>

    [*] --> fork_state
    fork_state --> State2
    fork_state --> State3

    State2 --> join_state
    State3 --> join_state
    join_state --> [*]
```

### Notes

```mermaid
stateDiagram-v2
    State1: The state with a note
    note right of State1
        Important information!
    end note
```

### Concurrency

Use `--` for concurrent regions within a state.

```mermaid
stateDiagram-v2
    state Active {
        [*] --> NumLockOff
        NumLockOff --> NumLockOn : EvNumLockPressed
        --
        [*] --> CapsLockOff
        CapsLockOff --> CapsLockOn : EvCapsLockPressed
    }
```

### Direction

Set diagram direction: `TB` (Top-Bottom), `LR` (Left-Right), `RL`, `BT`.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> A
    A --> B
```

## Comprehensive Example

```mermaid
stateDiagram-v2
    [*] --> Active

    state Active {
        [*] --> Ready
        Ready --> Running : Start
        Running --> Ready : Pause

        state Running {
            [*] --> Process
            Process --> [*]
        }

        --

        [*] --> Monitor
        Monitor --> [*]
    }

    Active --> Crashed : Error
    Crashed --> Active : Reset
    Active --> [*] : Shutdown

    note right of Crashed : System failure state
```""",
    "timeline.md": """# Timeline Diagram

A timeline diagram illustrates a chronology of events, dates, or periods of time.

## Syntax

### Basic Syntax

Start with `timeline` keyword. Define time periods and events using colon separators.

```mermaid
timeline
    title History of Social Media Platform
    2002 : LinkedIn
    2004 : Facebook : Google
    2005 : YouTube
    2006 : Twitter
```

### Sections

Group time periods into named sections.

```mermaid
timeline
    title Industrial Revolution
    section 17th-20th century
        Industry 1.0 : Machinery, Water power, Steam power
        Industry 2.0 : Electricity, Internal combustion engine, Mass production
        Industry 3.0 : Electronics, Computers, Automation
    section 21st century
        Industry 4.0 : Internet, Robotics, Internet of Things
```

## Comprehensive Example

```mermaid
timeline
    title Product Roadmap
    section Q1 2024
        January : Market Research
                : Competitor Analysis
        February : Initial Design : Prototyping
        March : Stakeholder Review
    section Q2 2024
        April : Development Kickoff
        May : Alpha Release
        June : Beta Testing : Bug Fixes
```""",
    "treemap.md": """# Treemap

A treemap diagram displays hierarchical data as a set of nested rectangles.

## Syntax

### Basic Syntax

Use `treemap-beta` keyword. Indentation defines hierarchy.

```mermaid
treemap-beta
    "Root"
        "Branch 1"
            "Leaf 1.1": 10
            "Leaf 1.2": 20
        "Branch 2"
            "Leaf 2.1": 15
```

### Styling

Use `:::className` to apply styles defined with `classDef`.

```mermaid
treemap-beta
    "Main"
        "A": 20
        "B":::important
            "B1": 10
            "B2": 15

    classDef important fill:#f96,stroke:#333,stroke-width:2px;
```

## Comprehensive Example

```mermaid
treemap-beta
    "Company Budget"
        "Engineering"
            "Backend": 40
            "Frontend": 35
            "DevOps": 25
        "Sales"
            "Domestic": 60
            "International": 40
        "Marketing"
            "Online": 30
            "Events": 20
```""",
    "xyChart.md": """# XY Chart

XY charts encompass various types of charts using x and y axes, such as bar and line charts.

## Syntax

### Basic Syntax

Start with `xychart-beta`. Define orientation (optional), title, axis, and data.
Use quotes for multi-word strings.

```mermaid
xychart-beta
    title "Chart Title"
    x-axis [cat1, "cat 2", cat3]
    y-axis "Y Title" 0 --> 100
    bar [10, 50, 20]
    line [10, 50, 20]
```

### Orientations

Vertical (default) or horizontal.

```mermaid
xychart-beta horizontal
    title "Horizontal Chart"
    x-axis [A, B, C]
    bar [10, 20, 30]
```

## Comprehensive Example

```mermaid
xychart-beta
    title "Monthly Sales Performance"
    x-axis [Jan, Feb, Mar, Apr, May, Jun]
    y-axis "Revenue ($k)" 0 --> 120

    %% Target Revenue (Line)
    line [50, 60, 70, 80, 90, 100]

    %% Actual Revenue (Bar)
    bar [45, 65, 68, 85, 95, 105]
```""",
    "zenuml.md": """# ZenUML

ZenUML is a sequence diagram language that allows you to generate diagrams from pseudocode.

## Syntax

### Participants

Participants can be declared explicitly or implicitly.

```mermaid
zenuml
    // Implicit
    Alice->Bob: Hi

    // Explicit
    Client
    Service
```

### Messages

Use `.` for sync calls, `->` for async.

```mermaid
zenuml
    // Sync (Method call)
    Service.Calculate() {
        Database.Query()
    }

    // Async (Event)
    User->Service: Click
```

### Control Structures

`if`, `while`, `opt`, `par`, `try/catch`.

```mermaid
zenuml
    if(isValid) {
        Process()
    } else {
        Reject()
    }

    while(true) {
        Poll()
    }
```

## Comprehensive Example

```mermaid
zenuml
    title Order Processing

    OrderService.CreateOrder(order) {
        if (order.isValid) {
            Inventory.Reserve(order.items) {
                return true
            }

            try {
                PaymentGateway.Charge(order.total)
                EventBus->OrderCreated
            } catch {
                Inventory.Release(order.items)
                throw PaymentFailed
            }
        }
    }
```""",
}


class ReadMermaidReferenceInput(BaseModel):
    """Input schema for read_mermaid_reference tool."""

    reference: str = Field(
        ...,
        description="The name of the reference file to read (e.g., 'flowchart' or 'flowchart.md').",
    )


class ReadMermaidReferenceTool(BaseTool):
    """Tool for reading Mermaid diagram references and examples.

    This tool allows the agent to read specific documentation files from the
    references directory to understand syntax and see examples for different
    diagram types.
    """

    name: str = "read_mermaid_reference"
    display_name: str = "查阅参考文档"
    description: str = (
        "Read documentation and examples for specific Mermaid diagram types."
    )

    args_schema: Type[BaseModel] = ReadMermaidReferenceInput

    def _run(
        self,
        reference: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute the tool synchronously."""
        try:
            # Normalize reference name
            reference = reference.strip()
            if not reference.endswith(".md"):
                reference += ".md"

            # Check if reference exists in the dictionary
            if reference in MERMAID_REFERENCES:
                return MERMAID_REFERENCES[reference]

            # If not found, list available references
            available = [f.replace(".md", "") for f in MERMAID_REFERENCES.keys()]
            return (
                f"Error: Reference '{reference}' not found. "
                f"Available references: {', '.join(sorted(available))}"
            )

        except Exception as e:
            return f"Error reading reference: {str(e)}"

    async def _arun(
        self,
        reference: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute the tool asynchronously."""
        # For dictionary lookup, sync execution is fine
        return self._run(reference, run_manager)
