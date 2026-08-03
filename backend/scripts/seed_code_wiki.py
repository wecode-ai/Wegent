# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fill a code wiki with pages without running an agent.

Everything after the agent — the publish gate, the projection, attachment storage,
the index queue and the reader — can be exercised without a model or an executor,
because the agent's only interface is the write API. This plays that interface.

What it does *not* cover: choosing a run mode, cloning the repository, and whether
the model produces anything worth reading. Those need the real thing.

    uv run python scripts/seed_code_wiki.py --kb-id 12
    uv run python scripts/seed_code_wiki.py --kb-id 12 --pages index architecture \\
        architecture/backend
"""

import argparse
import sys
from datetime import datetime

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.schemas.wiki import (
    WikiContentSection,
    WikiContentSummary,
    WikiContentWriteRequest,
)
from app.services.knowledge.code_wiki.generation import start_generation
from app.services.knowledge.code_wiki.registry import wiki_owner
from app.services.wiki_service import WikiService

DEFAULT_PAGES = ["index", "architecture", "architecture/backend", "guides/setup"]


def _body(path: str) -> str:
    """Content with a heading tree and a diagram, so the outline and Mermaid show."""
    return f"""# {path}

Seeded page for `{path}`.

## What this covers

Placeholder prose so the outline on the right has something to list.

## How it fits

```mermaid
flowchart TD
  A[Request] --> B[{path}]
  B --> C[(Storage)]
```

### A deeper heading

The outline folds anything below level three, so this is the last level shown.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kb-id", type=int, required=True, help="Code wiki to fill")
    parser.add_argument(
        "--pages", nargs="*", default=DEFAULT_PAGES, help="Page paths to write"
    )
    parser.add_argument(
        "--commit",
        default="seed" + datetime.now().strftime("%H%M%S"),
        help="Commit the seeded version claims to document",
    )
    args = parser.parse_args()

    with SessionLocal() as db:
        knowledge_base = db.get(Kind, args.kb_id)
        if knowledge_base is None or knowledge_base.kind != "KnowledgeBase":
            print(f"No knowledge base {args.kb_id}", file=sys.stderr)
            return 1

        requester = db.get(User, knowledge_base.user_id)
        if requester is None:
            print(f"Knowledge base {args.kb_id} has no owner", file=sys.stderr)
            return 1
        owner: User = wiki_owner(db, requester)
        started = start_generation(
            db,
            knowledge_base=knowledge_base,
            user=owner,
            head_commit=args.commit,
        )
        if not started.started:
            print(f"No run needed: {started.decision.reason}", file=sys.stderr)
            return 1

        generation: WikiGeneration = started.generation
        db.commit()
        print(f"generation {generation.id} ({started.decision.mode})")

        # Written through the same API the agent uses, so the path matching, the
        # removal channel and the completion handoff are all the real ones.
        service = WikiService()
        service.save_generation_contents(
            db,
            WikiContentWriteRequest(
                generation_id=generation.id,
                sections=[
                    WikiContentSection(
                        type="chapter",
                        title=path.rsplit("/", 1)[-1].replace("-", " ").title(),
                        content=_body(path),
                        path=path,
                    )
                    for path in args.pages
                ],
            ),
        )

        service.save_generation_contents(
            db,
            WikiContentWriteRequest(
                generation_id=generation.id,
                sections=[],
                summary=WikiContentSummary(
                    status="COMPLETED",
                    head_commit=args.commit,
                    structure_order=list(args.pages),
                ),
            ),
        )

        db.refresh(generation)
        published = (
            (knowledge_base.json or {}).get("spec", {}).get("publishedGenerationId")
        )
        pages = (
            db.query(WikiContent)
            .filter(WikiContent.generation_id == generation.id)
            .count()
        )
        print(
            f"status={generation.status} pages={pages} published={published}",
            file=(
                sys.stderr
                if generation.status != WikiGenerationStatus.COMPLETED
                else sys.stdout
            ),
        )
        return 0 if published == generation.id else 1


if __name__ == "__main__":
    raise SystemExit(main())
