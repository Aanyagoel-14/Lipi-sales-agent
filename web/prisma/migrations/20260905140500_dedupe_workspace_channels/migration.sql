-- Backfill for the `channels: { push }` bug: reconnecting a channel appended it
-- again, so the column accumulated duplicates. Nothing reads it today, but a
-- column that lies is a column someone will trust later.
UPDATE "workspaces" w
SET "channels" = sub.deduped
FROM (
  SELECT id, ARRAY(SELECT DISTINCT unnest("channels")) AS deduped
  FROM "workspaces"
) AS sub
WHERE w.id = sub.id
  AND array_length(w."channels", 1) IS DISTINCT FROM array_length(sub.deduped, 1);
