# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pure rendering helpers for GitLab MR fix-task cards."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.models.cloud_project import CloudProject
from app.models.gitlab_mr import MRRecord

HISTORY_RENDER_LIMIT = 3

# Pipeline statuses that count as "CI did not pass" for the task preamble.
_FAILED_PIPELINE_STATUSES = {"failed", "canceled", "error"}

# GitLab job traces carry terminal escape sequences; strip them so the card
# description renders as plain text.
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# Stored timestamps are UTC (GitLab API / backend utcnow); display in China time.
_CHINA_TZ = timezone(timedelta(hours=8))


def _board_statuses(project: CloudProject) -> list[dict[str, Any]]:
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    board = metadata.get("board_config")
    board = board if isinstance(board, dict) else {}
    statuses = board.get("statuses")
    if not isinstance(statuses, list):
        return []
    return [item for item in statuses if isinstance(item, dict) and item.get("id")]


def resolve_status_id(project: CloudProject, logical: str) -> str:
    """Map a logical status (inbox/in_progress/in_review/completed) to a board column id.

    Matches the project's ``board_config.statuses`` by exact id, then by a name
    keyword, then falls back to the first (or last, for completed) configured
    column. Mirrors ``LoopItemService._project_status_ids`` fallback list when
    the project has no board config.
    """
    fallback_defaults = {
        "inbox": "inbox",
        "in_progress": "in_progress",
        "in_review": "in_review",
        "completed": "completed",
    }
    statuses = _board_statuses(project)
    if not statuses:
        return fallback_defaults[logical]
    exact = next(
        (str(item["id"]) for item in statuses if str(item["id"]) == logical), None
    )
    if exact is not None:
        return exact
    keywords = {
        "inbox": ("收集箱", "收件箱", "inbox"),
        "in_progress": ("进行中", "进行", "in progress", "todo"),
        "in_review": ("待确认", "待验证", "确认", "review"),
        "completed": ("已完成", "完成", "done", "completed"),
    }
    wanted = keywords[logical]
    for item in statuses:
        name = str(item.get("name") or "").lower()
        if any(keyword in name for keyword in wanted):
            return str(item["id"])
    if logical == "completed":
        return str(statuses[-1]["id"])
    if logical == "in_review":
        # No review-like column configured; land next to in-progress rather
        # than on the first (often "inbox") column.
        return resolve_status_id(project, "in_progress")
    return str(statuses[0]["id"])


def _short_sha(sha: str) -> str:
    return sha[:8] if sha else ""


def max_retry_count(project: CloudProject) -> int:
    """Auto-run cap from the project's ``ai_automation`` config (default 10).

    ``0`` means auto-retry is disabled: the state machine never re-triggers a
    robot run on its own.
    """
    metadata = project.metadata_json if isinstance(project.metadata_json, dict) else {}
    ai_automation = metadata.get("ai_automation")
    ai_automation = ai_automation if isinstance(ai_automation, dict) else {}
    raw = ai_automation.get("max_retry_count")
    try:
        return int(raw) if raw is not None else 10
    except (TypeError, ValueError):
        return 10


def _unseen_note_ids(record: MRRecord) -> set[int]:
    """Standalone note ids in the current round the last robot run did not see.

    Empty when no run has dispatched yet — a human-driven MR has no run to be
    "unseen by", so the round-based summary already handles it. Older rounds'
    comments are addressed by the latest commit and never count as pending.
    """
    seen = set(int(x) for x in (record.seen_note_ids or []))
    if not seen:
        return set()
    rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
    current = rounds[-1] if rounds else {}
    current_ids = {
        int(n.get("id") or 0)
        for n in (current.get("notes") or [])
        if isinstance(n, dict)
    }
    return current_ids - seen


def _pending_review_notes(record: MRRecord) -> list[dict[str, object]]:
    """Current-round comments the latest run still needs to act on.

    Empty ``seen_note_ids`` means no robot run has dispatched yet (a human-driven
    MR): every current-round comment is pending. Once a run has dispatched, only
    comments it has not seen are pending — the rest were addressed and settled the
    card toward in_review without a re-pull, so they must not be shown as pending
    feedback nor drive a "keep fixing" instruction.
    """
    rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
    current = rounds[-1] if rounds else {}
    current_notes = (
        current.get("notes") if isinstance(current.get("notes"), list) else []
    )
    if not record.seen_note_ids:
        return list(current_notes)
    unseen = _unseen_note_ids(record)
    return [n for n in current_notes if int(n.get("id") or 0) in unseen]


def _format_ts(iso: str) -> str:
    """Format a stored UTC ISO timestamp as ``MM-DD HH:mm`` China time."""
    if not iso:
        return ""
    s = iso.strip()
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except ValueError:
        return s.replace("T", " ")[:16][5:]
    if dt.tzinfo is None:
        # Naive timestamps come from backend utcnow(); treat as UTC.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_CHINA_TZ).strftime("%m-%d %H:%M")


def trace_tail(trace: str, limit_chars: int = 4000, limit_lines: int = 50) -> str:
    trace = _ANSI_ESCAPE_RE.sub("", trace or "")
    lines = [line.rstrip("\n") for line in trace.splitlines() if line.strip()]
    if not lines:
        return ""
    tail = "\n".join(lines[-limit_lines:])
    if len(tail) > limit_chars:
        tail = tail[-limit_chars:]
    return tail


def _task_instruction(project: CloudProject, record: MRRecord) -> str:
    """Instruction preamble for the model that will act on this card.

    Driven by the same logical state as the card column: the current round's CI
    outcome plus whether the latest commit has any unhandled standalone review
    comments (a new commit always marks earlier comments as addressed).
    """
    branch = record.source_branch or ""
    snapshot = record.snapshot_json if isinstance(record.snapshot_json, dict) else {}
    url = str(snapshot.get("web_url") or "")
    has_pending_comments = bool(_pending_review_notes(record))
    pipeline_status = str(record.pipeline_status or "")
    fetch_hint = (
        f"评审意见的完整行内上下文（针对哪一行、原文）请查看 MR：{url}" if url else ""
    )
    precommit_hint = (
        "提交前请重新拉取该 MR 的最新评审意见（如 gitlab api "
        f"merge_requests/{record.mr_iid}/notes），确认没有新增遗漏后再 push。"
    )
    no_comment_hint = (
        "禁止回复或新增任何评论（包括在原有 discussion 内回复）；所有回应一律通过"
        "修改代码并 push 到源分支表达。"
    )
    ci_log_hint = (
        "CI 失败详情请打开各失败 job 的日志链接（或调 GitLab API）查看完整 trace；"
        "概述中的摘要是截断提示，不要当作完整日志。"
    )
    completion_condition = (
        "完成条件：push 后必须重新拉取该 MR 的最新评审意见（notes），确认所有评论/review "
        "都已处理且 CI 通过，才能结束任务；否则继续修复并再次 push。"
    )
    if record.state == "closed":
        return "该 MR 已合并/关闭，无需处理。"
    if pipeline_status in _FAILED_PIPELINE_STATUSES:
        if has_pending_comments:
            return (
                "CI 未通过且有新的评审意见需要处理。\n"
                "请根据下方的评审意见和 CI 失败信息修复代码，提交并 push 到源分支 "
                f"`{branch}`（push 后会触发 CI 重跑），处理完所有评审意见。\n"
                f"{fetch_hint}\n{ci_log_hint}\n{precommit_hint}\n{no_comment_hint}\n{completion_condition}"
            )
        return (
            "这是一个 CI 未通过 / 有评审意见的 MR 修复任务。\n"
            "请根据下方的评审意见和 CI 失败信息修复代码，提交并 push 到源分支 "
            f"`{branch}`（push 后会触发 CI 重跑），直到 CI 通过且评审意见全部处理完毕。\n"
            f"{fetch_hint}\n{ci_log_hint}\n{precommit_hint}\n{no_comment_hint}\n{completion_condition}"
        )
    if has_pending_comments:
        return (
            "CI 已通过，但仍有新的评审意见需要处理。\n"
            "请根据下方或 MR 页面的评审意见修改代码，提交并 push 到源分支 "
            f"`{branch}`（push 后会触发 CI 重跑），处理完所有评审意见。\n"
            f"{fetch_hint}\n{precommit_hint}\n{no_comment_hint}\n{completion_condition}"
        )
    if pipeline_status == "success":
        return (
            "已提交修复且 CI 通过，等待人工/评审确认，无需再修改。"
            f"源分支：`{branch}`"
        )
    return "该 MR 正在等待 CI 结果，请稍后再查看。" f"源分支：`{branch}`"


def render_card_description(project: CloudProject, record: MRRecord) -> str:
    """Render the fix-card description from the record's snapshot and rounds.

    Current round renders the CI failure excerpt (job title + short trace tail +
    job URL) and review comments; older rounds collapse into one-line history
    entries so the description stays bounded as an MR iterates.
    """
    snapshot = record.snapshot_json if isinstance(record.snapshot_json, dict) else {}
    rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
    current = rounds[-1] if rounds else {}

    lines: list[str] = []
    lines.append(f"## MR !{record.mr_iid} · {record.mr_title or ''}")
    url = str(snapshot.get("web_url") or "")
    author = str(snapshot.get("author_username") or "")
    repository = str(snapshot.get("repository") or "")
    branch_info = (
        f"{record.source_branch} → {record.target_branch}"
        if record.source_branch and record.target_branch
        else ""
    )
    meta_parts = [f"repo: {repository}"] if repository else []
    meta_parts += [url, branch_info, author]
    meta = " · ".join(part for part in meta_parts if part)
    if meta:
        lines.append(meta)

    # Auto-retry exhausted: surface why the robot stopped instead of leaving the
    # card looking active with nothing happening.
    cap = max_retry_count(project)
    if record.state == "actionable" and record.auto_retrigger_count >= cap:
        reason = (
            "已关闭自动重试，机器人不会自动修复。"
            if cap == 0
            else f"已达自动重试上限（{record.auto_retrigger_count} 次）仍失败，机器人已停止自动修复。"
        )
        lines.append("")
        lines.append(f"⚠️ {reason}请人工介入或关闭重建 MR。")

    lines.append("")
    lines.append("### 任务")
    lines.append(_task_instruction(project, record))

    lines.append("")
    # Only the current round's standalone comments are unhandled feedback; older
    # rounds' comments were addressed by the latest commit and live in history.
    feedback_notes = _pending_review_notes(record)

    lines.append("### 评审意见")
    unseen = _unseen_note_ids(record)
    if unseen:
        lines.append(f"（本次运行后新增 {len(unseen)} 条评论待处理）")
    if feedback_notes:
        for note in sorted(
            feedback_notes, key=lambda n: str(n.get("created_at") or "")
        ):
            note_author = str(note.get("author") or "")
            note_body = str(note.get("note") or "")
            ts = _format_ts(str(note.get("created_at") or ""))
            pos = note.get("position")
            pos = pos if isinstance(pos, dict) else {}
            loc = ""
            if pos.get("path") and pos.get("line"):
                loc = f" @ {pos['path']}:{pos['line']}"
            prefix = f"**{note_author}**（{ts}）" if ts else f"**{note_author}**"
            lines.append(f"- {prefix}{loc}：{note_body}")
    else:
        lines.append("暂无评审意见。")
    mr_url = str(snapshot.get("web_url") or "")
    if mr_url:
        lines.append(f"（评审意见的完整行内上下文请查看 MR：{mr_url}）")

    lines.append("")
    lines.append(
        f"### 本轮 CI（R{record.round_number} @ {_short_sha(record.head_sha)}）"
    )
    lines.append(
        f"CI 状态：{str(current.get('pipeline_status') or record.pipeline_status)}"
    )
    failed_jobs = sorted(
        (
            current.get("failed_jobs")
            if isinstance(current.get("failed_jobs"), list)
            else []
        ),
        key=lambda job: str(job.get("started_at") or ""),
    )
    for job in failed_jobs:
        name = str(job.get("name") or "")
        stage = str(job.get("stage") or "")
        url = str(job.get("web_url") or "")
        ts = _format_ts(str(job.get("started_at") or ""))
        label = f"`{name}`（{stage}）@{ts}" if ts else f"`{name}`（{stage}）"
        # The card only carries a short trace excerpt; the model fetches the
        # full log itself from the job URL when it needs more context.
        summary = trace_tail(
            str(job.get("trace_tail") or ""), limit_lines=8, limit_chars=600
        ).strip()
        link = f" · {url}" if url else ""
        if summary:
            lines.append(f"- {label}{link}\n```\n{summary}\n```")
        else:
            lines.append(f"- {label}{link}")

    # Per-round comment count is the number NEW in that round (notes not seen
    # in earlier rounds), matching the actionable semantics.
    seen_note_ids: set[int] = set()
    round_new_counts: dict[int, int] = {}
    for item in rounds:
        item_ids = {
            int(n.get("id") or 0)
            for n in (item.get("notes") or [])
            if isinstance(n, dict)
        }
        round_new_counts[int(item.get("round_number") or 0)] = len(
            item_ids - seen_note_ids
        )
        seen_note_ids |= item_ids

    history = rounds[:-1][-HISTORY_RENDER_LIMIT:]
    if history:
        lines.append("")
        lines.append(f"### 历史（最近 {len(history)} 轮）")
        for item in history:
            status = str(item.get("pipeline_status") or "")
            job_count = len(item.get("failed_jobs") or [])
            note_count = round_new_counts.get(int(item.get("round_number") or 0), 0)
            ts = _format_ts(str(item.get("at") or ""))
            summary = f"R{item.get('round_number')}（{_short_sha(str(item.get('sha') or ''))}）"
            if ts:
                summary += f" @{ts}"
            parts = [status]
            if job_count:
                parts.append(f"{job_count} 个失败 job")
            if note_count:
                parts.append(f"新增 {note_count} 条评论")
            lines.append(f"- {summary}：{' · '.join(parts)}")

    return "\n".join(lines)


def mr_snapshot(record: MRRecord) -> dict[str, Any]:
    """Projection of the MR snapshot stored on the board card."""
    snapshot = record.snapshot_json if isinstance(record.snapshot_json, dict) else {}
    return {
        "provider": "gitlab",
        "mr_iid": record.mr_iid,
        "title": record.mr_title or "",
        "web_url": str(snapshot.get("web_url") or ""),
        "repository": str(snapshot.get("repository") or ""),
        "domain": str(snapshot.get("domain") or ""),
        "source_branch": record.source_branch or "",
        "target_branch": record.target_branch or "",
        "author_id": record.author_id,
        "author_username": str(snapshot.get("author_username") or ""),
        "head_sha": record.head_sha or "",
    }
