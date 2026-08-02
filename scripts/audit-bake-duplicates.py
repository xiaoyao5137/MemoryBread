#!/usr/bin/env python3
"""只读审计 bake 提炼产物重复，不修改数据库。"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote


REFERENCE_APPS = {
    "kim",
    "kem",
    "chatgpt",
    "钉钉",
    "dingtalk",
    "飞书",
    "feishu",
    "lark",
    "slack",
    "teams",
    "microsoft teams",
    "snip",
    "amphetamine",
}

DOCUMENT_URL_MARKERS = (
    "docs.corp",
    "/docs/",
    "docs.google",
    "/document/",
    "yuque.com",
    "feishu.cn/docx",
    "feishu.cn/wiki",
    "larkoffice.com/wiki",
    "notion.so",
    "confluence",
    "/wiki/",
    "shimo.im",
    "/d/home/",
    "/s/home/",
    "/k/home/",
)


def canonical_url(url: str | None) -> str | None:
    value = (url or "").strip()
    if not value:
        return None
    if not any(marker in value.lower() for marker in DOCUMENT_URL_MARKERS):
        return None
    value = value.split("#", 1)[0].split("?", 1)[0].rstrip("/")
    value = re.sub(r"^https?://", "", value, flags=re.IGNORECASE)
    return value.lower() or None


def searchable_title(value: str | None) -> str:
    return re.sub(r"[\W_]+", "", (value or "").lower(), flags=re.UNICODE)


def load_documents(db_path: Path) -> list[dict]:
    uri = f"file:{quote(str(db_path.resolve()))}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, title, source_app_name, source_win_title, source_url,
                   source_memory_ids, source_capture_ids, content_hash,
                   length(coalesce(full_content, '')) AS content_length,
                   creation_mode, generation_version, created_at
            FROM bake_documents
            WHERE deleted_at IS NULL
            ORDER BY id
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def build_report(documents: list[dict], title_contains: str | None) -> dict:
    url_groups: dict[str, list[dict]] = defaultdict(list)
    for document in documents:
        identity = canonical_url(document["source_url"])
        if identity:
            url_groups[identity].append(document)

    duplicate_url_groups = []
    for identity, group in url_groups.items():
        if len(group) < 2:
            continue
        survivor = min(group, key=lambda item: item["id"])
        duplicate_url_groups.append(
            {
                "document_identity": identity,
                "survivor_id": survivor["id"],
                "duplicate_ids": [
                    item["id"] for item in group if item["id"] != survivor["id"]
                ],
                "titles": [item["title"] for item in group],
            }
        )
    duplicate_url_groups.sort(
        key=lambda item: (-len(item["duplicate_ids"]), item["survivor_id"])
    )

    suspicious_references = []
    for document in documents:
        app = (document["source_app_name"] or "").strip().lower()
        window = (document["source_win_title"] or "").strip().lower()
        if document["source_url"]:
            continue
        if app in REFERENCE_APPS or (app and (not window or window == app)):
            suspicious_references.append(document)

    target_rows = []
    if title_contains:
        needle = searchable_title(title_contains)
        target_rows = [
            document
            for document in documents
            if needle and needle in searchable_title(document["title"])
        ]

    return {
        "active_document_count": len(documents),
        "duplicate_url_group_count": len(duplicate_url_groups),
        "documents_in_duplicate_url_groups": sum(
            len(group["duplicate_ids"]) + 1 for group in duplicate_url_groups
        ),
        "extra_url_documents": sum(
            len(group["duplicate_ids"]) for group in duplicate_url_groups
        ),
        "duplicate_url_groups": duplicate_url_groups,
        "suspicious_reference_artifact_count": len(suspicious_references),
        "suspicious_reference_artifacts": suspicious_references,
        "title_filter": title_contains,
        "title_filter_count": len(target_rows),
        "title_filter_rows": target_rows,
        "dry_run": True,
    }


def print_markdown(report: dict) -> None:
    print("# Bake 重复产物只读审计")
    print()
    print(f"- 有效文档：{report['active_document_count']}")
    print(f"- 重复 URL 组：{report['duplicate_url_group_count']}")
    print(f"- URL 重复产生的多余记录：{report['extra_url_documents']}")
    print(
        f"- 无 URL 且来自聊天/AI/截屏等引用面的可疑文档："
        f"{report['suspicious_reference_artifact_count']}"
    )
    if report["title_filter"]:
        print(
            f"- 标题筛选 `{report['title_filter']}`："
            f"{report['title_filter_count']} 条"
        )

    print()
    print("## URL 确定性归并候选")
    print()
    for group in report["duplicate_url_groups"]:
        print(
            f"- 保留 #{group['survivor_id']}；候选软删除 "
            f"{', '.join(f'#{item}' for item in group['duplicate_ids'])}；"
            f"identity=`{group['document_identity']}`"
        )

    if report["title_filter"]:
        print()
        print("## 指定标题命中")
        print()
        for document in report["title_filter_rows"]:
            print(
                f"- #{document['id']} `{document['title']}`；"
                f"app=`{document['source_app_name'] or ''}`；"
                f"window=`{document['source_win_title'] or ''}`；"
                f"url=`{document['source_url'] or ''}`；"
                f"sources={document['source_memory_ids']}"
            )

    print()
    print("> dry-run：未修改数据库。URL 组可确定性归并；无 URL 引用型产物需人工确认后软删除。")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db",
        type=Path,
        default=Path.home() / ".memory-bread" / "memory-bread.db",
    )
    parser.add_argument("--title-contains")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args()

    report = build_report(load_documents(args.db), args.title_contains)
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_markdown(report)


if __name__ == "__main__":
    main()
