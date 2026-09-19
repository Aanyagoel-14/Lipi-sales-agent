#!/bin/sh
# Sandbox bootstrap. Sandcastle runs this inside the container, in the root of
# the bind-mounted worktree, once per sandbox, before the agent starts.
#
# The dependency tree is NOT installed here. It is baked into the image at
# /opt/lipi/web/node_modules (see Dockerfile) and linked in, so a sandbox
# needs no registry access to start. The old hook, `cd web && npm ci`, pulled
# the full tree from npm once per sandbox — N times in parallel per iteration
# — and the whole run died on the first ECONNRESET.
set -eu

IMAGE_DEPS=/opt/lipi/web

# Refuse to run against a primary checkout. In a worktree `.git` is a file
# pointing at the parent repo; in a primary checkout it is a directory. The
# `head` branch strategy bind-mounts the host's own working copy, and a hook
# there edits files on the host machine — that is how a Linux `npm ci` once
# replaced the macOS node_modules on the developer's laptop.
if [ -d .git ]; then
  echo "sandbox-setup.sh: refusing to run in a primary checkout (.git is a directory)." >&2
  echo "This sandbox is in head mode. Give it no hooks, or run it in a worktree." >&2
  exit 1
fi

# The cluster is initialised at image build time; nothing starts it.
sudo service postgresql start

cd web

# Fast path: link the worktree to the image's tree. The link lives in the
# worktree but resolves inside the container's own filesystem, so package
# reads never cross the bind mount and writes stay private to this container.
if [ ! -e node_modules ]; then
  ln -s "$IMAGE_DEPS/node_modules" node_modules
fi

# Slow path: this branch changed the lockfile (added or bumped a dependency).
# Replace the link with a real install. `--prefer-offline` serves everything
# the image already fetched from the npm cache warmed at build time; only the
# genuinely new packages touch the network, and ~/.npmrc retries those.
if ! cmp -s package-lock.json "$IMAGE_DEPS/package-lock.json"; then
  echo "package-lock.json differs from the image's; installing this branch's tree"
  [ -L node_modules ] && rm node_modules
  npm ci --prefer-offline --no-audit --no-fund
fi

# The client is generated from THIS branch's schema, not the image's. It is
# gitignored (web/src/generated/), so every fresh worktree lacks it.
npx prisma generate
