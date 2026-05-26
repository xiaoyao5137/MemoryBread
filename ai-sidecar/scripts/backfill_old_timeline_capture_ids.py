#!/usr/bin/env python3
"""
一次性回填脚本：为老版 bake_article 时间线条目补齐 capture_ids / key_timestamps。

背景：
  - 5/24 之前提炼器写入的时间线 category='bake_article'，缺少 capture_ids /
    key_timestamps / frag_app_name / start_time 等字段，导致前端时间线详情面板
    无法展示「关联片段」与「语义分段」。
  - 这些条目只持有单个 timeline.capture_id，关联面有限——本脚本据此把
    capture_ids 填成 [capture_id]，key_timestamps 填成单段语义分段。

使用：
  # 默认干跑（不写库），打印总数与抽样
  python ai-sidecar/scripts/backfill_old_timeline_capture_ids.py

  # 真正落库
  python ai-sidecar/scripts/backfill_old_timeline_capture_ids.py --apply

  # 自定义数据库路径
  python ai-sidecar/scripts/backfill_old_timeline_capture_ids.py \
      --db ~/.memory-bread/memory-bread.db --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".memory-bread" / "memory-bread.db"

# 仅处理 bake_article + 非自生成 + capture_ids 仍为空 的行（幂等）
SELECT_TARGETS_SQL = """
    SELECT t.id, t.capture_id, t.summary, t.overview, t.details,
           c.id  AS cap_id,
           c.ts  AS cap_ts,
           c.app_name AS cap_app,
           c.win_title AS cap_win
    FROM timelines t
    LEFT JOIN captures c ON c.id = t.capture_id
    WHERE t.category = 'bake_article'
      AND t.is_self_generated = 0
      AND (t.capture_ids IS NULL OR t.capture_ids = '' OR t.capture_ids = '[]')
"""

UPDATE_SQL = """
    UPDATE timelines
       SET capture_ids       = ?,
           key_timestamps    = ?,
           frag_app_name     = COALESCE(frag_app_name, ?),
           frag_win_title    = COALESCE(frag_win_title, ?),
           start_time        = COALESCE(start_time, ?),
           end_time          = COALESCE(end_time, ?),
           duration_minutes  = COALESCE(duration_minutes, 0),
           details           = ?
     WHERE id = ?
"""


def build_segment(cap_id: int, cap_ts: int, summary: str | None) -> dict:
    """构造单段 key_timestamps 元素，结构与前端 TimelineItem.keyTimestamps 一致。"""
    return {
        "capture_ids": [cap_id],
        "start_ts": cap_ts,
        "end_ts": cap_ts,
        "summary": (summary or "").strip(),
    }


def parse_source_timeline_id(details: str | None) -> int | None:
    if not details:
        return None
    try:
        parsed = json.loads(details)
    except json.JSONDecodeError:
        return None
    value = parsed.get("source_timeline_id", parsed.get("source_knowledge_id"))
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_details(details: str | None, source_id: int | None, source_details: str | None) -> str | None:
    if not details:
        return details
    try:
        parsed = json.loads(details)
    except json.JSONDecodeError:
        return details
    if source_id is not None:
        parsed["source_timeline_id"] = source_id
        parsed.pop("source_knowledge_id", None)
    if source_details:
        parsed["description"] = source_details
    return json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


def load_source_timeline_context(conn: sqlite3.Connection, row: sqlite3.Row) -> tuple[list[int], str | None, int, int, str | None, str | None, str | None]:
    """优先继承 source timeline 的聚合 capture 与语义分段；没有时降级成单条 capture。"""
    fallback_ids = [row["cap_id"]]
    fallback_segment = build_segment(row["cap_id"], row["cap_ts"], row["summary"] or row["overview"])
    fallback_key_timestamps = json.dumps([fallback_segment], ensure_ascii=False)

    source_id = parse_source_timeline_id(row["details"])
    if source_id is None:
        return fallback_ids, fallback_key_timestamps, row["cap_ts"], row["cap_ts"], row["cap_app"], row["cap_win"], normalize_details(row["details"], None, None)

    source = conn.execute(
        """
        SELECT capture_ids, key_timestamps, start_time, end_time,
               time_range_start, time_range_end, frag_app_name, frag_win_title, details
          FROM timelines
         WHERE id = ?
        """,
        (source_id,),
    ).fetchone()
    if source is None:
        return fallback_ids, fallback_key_timestamps, row["cap_ts"], row["cap_ts"], row["cap_app"], row["cap_win"], normalize_details(row["details"], source_id, None)

    try:
        source_ids = json.loads(source["capture_ids"] or "[]")
    except json.JSONDecodeError:
        source_ids = []
    if not source_ids:
        source_ids = fallback_ids

    source_key_timestamps = source["key_timestamps"]
    if not source_key_timestamps:
        source_key_timestamps = fallback_key_timestamps

    start_time = source["time_range_start"] or source["start_time"] or row["cap_ts"]
    end_time = source["time_range_end"] or source["end_time"] or row["cap_ts"]
    return (
        source_ids,
        source_key_timestamps,
        start_time,
        end_time,
        source["frag_app_name"] or row["cap_app"],
        source["frag_win_title"] or row["cap_win"],
        normalize_details(row["details"], source_id, source["details"]),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="回填老版 bake_article 时间线的 capture_ids/key_timestamps")
    parser.add_argument("--db", default=str(DEFAULT_DB), help=f"SQLite 数据库路径（默认 {DEFAULT_DB}）")
    parser.add_argument("--apply", action="store_true", help="真正写入；缺省则干跑")
    parser.add_argument("--sample", type=int, default=3, help="干跑时打印的抽样条数（默认 3）")
    args = parser.parse_args()

    db_path = os.path.expanduser(args.db)
    if not os.path.exists(db_path):
        print(f"[ERROR] 数据库不存在: {db_path}", file=sys.stderr)
        return 2

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"=== 回填老 bake_article 时间线 [{mode}] ===")
    print(f"DB = {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(SELECT_TARGETS_SQL).fetchall()
        total = len(rows)
        orphan = [r for r in rows if r["cap_id"] is None]
        valid = [r for r in rows if r["cap_id"] is not None]

        print(f"待回填条目数 (capture_ids 为空): {total}")
        print(f"  ├─ capture_id 仍存在 capture 表中：{len(valid)}")
        print(f"  └─ capture_id 已成孤儿（跳过）：{len(orphan)}")

        if not valid:
            print("没有可回填的条目，直接返回。")
            return 0

        # 干跑抽样
        if not args.apply and args.sample > 0:
            print(f"\n--- 抽样前 {min(args.sample, len(valid))} 条预览 ---")
            for r in valid[: args.sample]:
                source_ids, source_key_timestamps, *_ = load_source_timeline_context(conn, r)
                print(
                    f"timeline_id={r['id']}  cap_id={r['cap_id']}  app={r['cap_app']!r}  "
                    f"win={r['cap_win']!r}  ts={r['cap_ts']}\n"
                    f"  capture_ids -> {json.dumps(source_ids, ensure_ascii=False)}\n"
                    f"  key_timestamps -> {source_key_timestamps}"
                )

        if not args.apply:
            print("\n[DRY-RUN] 未写库。加 --apply 真正落库。")
            return 0

        # 真正落库（事务）
        updated = 0
        with conn:
            for r in valid:
                source_ids, source_key_timestamps, start_time, end_time, app_name, win_title, next_details = load_source_timeline_context(conn, r)
                conn.execute(
                    UPDATE_SQL,
                    (
                        json.dumps(source_ids),
                        source_key_timestamps,
                        app_name,
                        win_title,
                        start_time,
                        end_time,
                        next_details,
                        r["id"],
                    ),
                )
                updated += 1

        print(f"\n[APPLY] 已更新 {updated} 条；跳过孤儿 {len(orphan)} 条。")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
