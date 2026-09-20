-- Browser origins allowed to call /v1 with this workspace's API key.
-- Empty for every existing workspace: the allow-list opens nothing until an
-- operator puts an origin on it, and the widget's own `*` is unaffected.
ALTER TABLE "workspaces" ADD COLUMN "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[];
