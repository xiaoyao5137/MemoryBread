-- 025_add_capture_web_source.sql
-- 为采集记录补充网页来源信息，供时间线 / 文档 / 知识聚合展示与跳转。

ALTER TABLE captures ADD COLUMN url TEXT;
ALTER TABLE captures ADD COLUMN webpage_title TEXT;

CREATE INDEX IF NOT EXISTS idx_captures_url ON captures(url);
