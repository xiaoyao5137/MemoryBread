-- Bake no longer has a manual review queue. Existing generated artifacts are
-- treated as automatically stored so old "candidate" rows do not keep showing
-- up as pending confirmation work.

UPDATE bake_knowledge
SET user_verified = 1;

UPDATE bake_knowledge
SET content = json_set(content, '$.status', 'auto_created', '$.review_status', 'auto_created')
WHERE json_valid(content)
  AND COALESCE(json_extract(content, '$.status'), '') != 'ignored';

UPDATE bake_sops
SET user_verified = 1;

UPDATE bake_sops
SET content = json_set(content, '$.status', 'auto_created', '$.review_status', 'auto_created')
WHERE json_valid(content)
  AND COALESCE(json_extract(content, '$.status'), '') != 'ignored';

UPDATE bake_documents
SET review_status = 'auto_created',
    status = CASE WHEN status IN ('draft', 'pending_review') THEN 'enabled' ELSE status END
WHERE deleted_at IS NULL
  AND review_status IN ('draft', 'candidate', 'pending_review', 'auto_created');
