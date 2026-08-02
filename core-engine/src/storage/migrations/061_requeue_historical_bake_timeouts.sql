-- 061: 恢复旧版“一次失败即永久跳过”误伤的候选。
--
-- 504 超时与模型结构化输出截断现在会经过有界退避重试。历史记录已经推进了
-- unified watermark，因此必须先回退水位，再删除失败标记；只删除标记会继续漏处理。

UPDATE bake_watermarks
SET last_processed_ts = MIN(
        last_processed_ts,
        COALESCE(
            (
                SELECT MIN(
                    MAX(
                        COALESCE(t.updated_at_ms, 0),
                        COALESCE(
                            (SELECT MAX(c.ts) FROM captures c WHERE c.timeline_id = t.id),
                            0
                        )
                    )
                ) - 1
                FROM bake_retry_state r
                JOIN timelines t ON t.id = r.timeline_id
                WHERE r.last_error LIKE 'upstream error (504%'
                   OR r.last_error LIKE '%BAKE_OUTPUT_TRUNCATED%'
                   OR r.last_error LIKE '%truncated_json%'
            ),
            last_processed_ts
        )
    ),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE pipeline_name = 'unified'
  AND EXISTS (
      SELECT 1
      FROM bake_retry_state r
      WHERE r.last_error LIKE 'upstream error (504%'
         OR r.last_error LIKE '%BAKE_OUTPUT_TRUNCATED%'
         OR r.last_error LIKE '%truncated_json%'
  );

DELETE FROM bake_retry_state
WHERE last_error LIKE 'upstream error (504%'
   OR last_error LIKE '%BAKE_OUTPUT_TRUNCATED%'
   OR last_error LIKE '%truncated_json%';
