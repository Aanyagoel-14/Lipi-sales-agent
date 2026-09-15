# Twin Workflow

This document shows operational flows separately from the system architecture.

## 1. Workspace and data onboarding

```mermaid
flowchart TD
    A[User signs up] --> B[Create workspace]
    B --> C[Choose vertical]
    C --> D{How should data start?}
    D -->|Catalogue CSV| E[Browser parses and previews variant rows]
    E --> F[API validates rows again]
    F --> G[Transactional product and inventory import]
    D -->|Manual entry| H[Create product and variant grid]
    H --> G
    D -->|Sample catalogue| I[Add labelled sample products only]
    D -->|No data yet| J[Keep workspace empty]
    G --> K[Product and inventory Twin ready]
    I --> K
    J --> L[Empty dashboard with setup actions]
    K --> M[Connect channels and train the Twin]
```

No path creates fictional conversations, orders, customers, invoices, approvals
or KPIs.

## 2. Twin training and activation

```mermaid
flowchart LR
    A[Product and inventory data] --> D[Training readiness]
    B[Verified business facts] --> D
    C[Reply voice and examples] --> D
    D --> E[Run evaluation message]
    E --> F[Production ingest logic]
    F --> G[Reply, extracted intent, proposed actions and events]
    G --> H[Rollback transaction]
    H --> I{Operator satisfied?}
    I -->|No| B
    I -->|Yes| J[Set approval policy]
    J --> K[Connect live channel]
    K --> L[Twin is live]
```

Evaluation validates behavior without changing live stock, customer records,
orders, approvals or dashboard metrics.

## 3. Live message to grounded reply

```mermaid
flowchart TD
    A[Customer message] --> B{Source}
    B -->|WhatsApp / Telegram webhook| C[Authenticate provider]
    B -->|Web/API message| D[Authenticate workspace session]
    C --> E[Normalize to common inbound message]
    D --> E
    E --> F[Extract intent, quantity, attributes and deadline]
    F --> G[Resolve or create customer Twin]
    G --> H[Match product and precise variant]
    H --> I{Intent and stock allow an action?}
    I -->|Purchase + available| J[Reserve variant stock]
    J --> K[Create quoted order]
    K --> L[Dispatch Sales and Inventory agents]
    I -->|Stock question| M[Read available stock]
    I -->|Policy/question| N[Read verified knowledge]
    I -->|Missing detail or shortfall| O[Ask grounded follow-up]
    L --> P[Apply approval policy]
    M --> P
    N --> P
    O --> P
    P --> Q[Compose reply using voice]
    Q --> R[Append Twin events]
    R --> S{Reply approved?}
    S -->|Yes| T[Send through originating channel]
    S -->|No| U[Place action in approval queue]
```

## 4. State mutation and audit trail

```mermaid
sequenceDiagram
    participant Customer
    participant Channel
    participant Ingest as Ingest service
    participant DB as Twin database
    participant Agent
    participant Operator

    Customer->>Channel: Need 4 blue XL polos by Friday
    Channel->>Ingest: Authenticated normalized message
    Ingest->>DB: Load workspace, knowledge, catalogue and variants
    Ingest->>DB: Create/update customer and conversation
    Ingest->>DB: Reserve exact variant and create quoted order
    Ingest->>Agent: Sales and inventory action proposals
    Agent->>DB: Agent runs and required approvals
    Ingest->>DB: Append immutable Twin events
    alt Action can proceed
        Ingest->>Channel: Grounded reply
        Channel->>Customer: Send reply
    else Approval required
        DB->>Operator: Approval queue item
        Operator->>DB: Approve or reject
    end
```

## 5. Current-stock synchronization target

```mermaid
flowchart LR
    A[ERP / POS / Shopify / WMS] --> B[Inventory connector]
    B --> C[Validate source and idempotency key]
    C --> D[Map external SKU to product variant]
    D --> E[Correct stock through Twin inventory path]
    E --> F[Append inventory event]
    F --> G[Dashboard, agents and availability replies use new value]
    B --> H[Reconciliation and connector health]
    H --> I[Operator-visible exception queue]
```

CSV import is the initial-stock path; this connector flow is what keeps stock
current after it. Both are implemented. The source pushes absolute counts to
`POST /v1/inventory/:id/sync` with an idempotency key and its own cursor; a row
that cannot be mapped or applied lands in the exception queue on
`/dashboard/inventory/connectors` rather than being dropped.
