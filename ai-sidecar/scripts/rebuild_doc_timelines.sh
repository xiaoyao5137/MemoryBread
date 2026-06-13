#!/usr/bin/env bash
# 回溯重建含文档的混合 timeline。
#
# 背景：旧 FragmentGrouper 把多份文档 + 聊天 + 编码混进同一条 timeline，
# 导致文档内容被埋没、无法提炼成文档。新分组器已能让"一份文档独占一个 timeline"。
# 本脚本把目标 timeline 的成员 capture 重置为未处理，删除旧 timeline 及其 bake 产物，
# 让 background_processor 用新分组器重新生成干净的 timeline，再由 bake pipeline 重新提炼。
#
# 用法：
#   ./rebuild_doc_timelines.sh dry-run   # 只展示影响，不改数据
#   ./rebuild_doc_timelines.sh apply     # 实际执行（自动先备份）
set -euo pipefail

DB="$HOME/.memory-bread/memory-bread.db"
MODE="${1:-dry-run}"

# 目标 timeline：含文档型 capture 的混合 timeline（由 SQL 动态识别，避免硬编码过期 id）。
TARGET_SQL="
WITH tl AS (
  SELECT id, capture_ids FROM timelines
  WHERE category NOT LIKE 'bake_%' AND capture_ids IS NOT NULL AND capture_ids != '[]'
),
members AS (
  SELECT tl.id AS tlid, CAST(je.value AS INTEGER) AS cap_id
  FROM tl, json_each(tl.capture_ids) je
)
SELECT DISTINCT m.tlid
FROM members m JOIN captures c ON c.id = m.cap_id
WHERE c.url LIKE '%/d/home/%' OR c.url LIKE '%/s/home/%'
   OR c.url LIKE '%docs.corp%' OR c.url LIKE '%yuque%'
   OR c.url LIKE '%feishu.cn/doc%' OR c.url LIKE '%notion%'
"

TARGET_IDS=$(sqlite3 "$DB" "$TARGET_SQL" | paste -sd, -)
if [ -z "$TARGET_IDS" ]; then
  echo "没有识别到目标 timeline，无需重建。"
  exit 0
fi

echo "=== 目标 timeline ids: $TARGET_IDS ==="

# 受影响的成员 capture 数
CAP_COUNT=$(sqlite3 "$DB" "
WITH t AS (SELECT id, capture_ids FROM timelines WHERE id IN ($TARGET_IDS))
SELECT COUNT(DISTINCT CAST(je.value AS INTEGER))
FROM t, json_each(t.capture_ids) je;")

KN_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM bake_knowledge WHERE timeline_id IN ($TARGET_IDS);")
SOP_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM bake_sops WHERE timeline_id IN ($TARGET_IDS);")
DOC_COUNT=$(sqlite3 "$DB" "
SELECT COUNT(*) FROM bake_documents bd
WHERE bd.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM json_each(bd.source_memory_ids) je
  WHERE CAST(je.value AS INTEGER) IN ($TARGET_IDS)
);")

echo "将重置 capture 数: $CAP_COUNT"
echo "将删除 timeline 数: $(echo $TARGET_IDS | tr ',' '\n' | wc -l | tr -d ' ')"
echo "将删除 bake_knowledge: $KN_COUNT"
echo "将删除 bake_sops: $SOP_COUNT"
echo "将软删除 bake_documents: $DOC_COUNT"

if [ "$MODE" = "dry-run" ]; then
  echo ""
  echo "[dry-run] 未改动任何数据。确认无误后执行: $0 apply"
  exit 0
fi

if [ "$MODE" != "apply" ]; then
  echo "未知模式: $MODE (用 dry-run 或 apply)"; exit 1
fi

# ── apply ──────────────────────────────────────────────────────────
BACKUP="/tmp/memory-bread-pre-rebuild-$(date +%s).db"
cp "$DB" "$BACKUP"
echo "已备份数据库: $BACKUP"

sqlite3 "$DB" <<SQL
-- trusted_schema=ON：允许触发器写 FTS 虚拟表（sqlite3 CLI 默认关闭，应用层默认开启）
PRAGMA trusted_schema = ON;
PRAGMA foreign_keys = ON;
BEGIN;

-- 1) 删除目标 timeline 已产出的 bake 产物
DELETE FROM bake_knowledge WHERE timeline_id IN ($TARGET_IDS);
DELETE FROM bake_sops WHERE timeline_id IN ($TARGET_IDS);

-- 2) 软删除关联的 document（保留行便于追溯，但排除出列表与去重）
UPDATE bake_documents
SET deleted_at = $(date +%s)000
WHERE deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM json_each(bake_documents.source_memory_ids) je
  WHERE CAST(je.value AS INTEGER) IN ($TARGET_IDS)
);

-- 3) 重置成员 capture 为未处理，让 background_processor 重新分组
UPDATE captures SET timeline_id = NULL
WHERE id IN (
  SELECT DISTINCT CAST(je.value AS INTEGER)
  FROM timelines t, json_each(t.capture_ids) je
  WHERE t.id IN ($TARGET_IDS)
);

-- 4) 删除旧 timeline 本身
DELETE FROM timelines WHERE id IN ($TARGET_IDS);

-- 5) 清理这些 timeline 的 bake 重试记录
DELETE FROM bake_retry_state WHERE timeline_id IN ($TARGET_IDS);

COMMIT;
SQL

echo "重建数据准备完成。"

# 6) 回退 bake watermark，让重新生成的 timeline 能进入 bake 候选
MINTS=$(sqlite3 "$DB" "SELECT MIN(ts)-1 FROM captures WHERE timeline_id IS NULL;")
sqlite3 "$DB" "UPDATE bake_watermarks SET last_processed_ts=0 WHERE pipeline_name='unified';"
echo "已重置 bake watermark=0（重新生成 timeline 后会被 bake 重新扫描）"

echo ""
echo "完成。background_processor 将在下个周期(<=30s)用新分组器重新生成 timeline。"
echo "如需立即触发 bake 提炼，待 timeline 生成后调用 POST /api/bake/run。"
echo "回滚：cp $BACKUP $DB （需先停 core/sidecar）"
