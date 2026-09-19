FROM node:22-bookworm

# Install system dependencies.
#
# `sudo` is required, not optional: Sandcastle implements a hook's `sudo: true`
# by prefixing the command with `sudo`, so a hook that needs root fails without
# it. Postgres is here because this repo's test suite talks to a real database —
# `web/vitest.config.mts` sets `fileParallelism: false` for exactly that reason,
# and `web/test/global-setup.ts` runs `prisma migrate deploy` before the first
# test. Without a live server in the sandbox, every agent's feedback loop dies
# at `npm test`.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  sudo \
  postgresql \
  postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI. The planner, implementer and merger all shell out to `gh`
# — the issue tracker is the loop's entire input and output — and the prompts'
# !`...` interpolations run INSIDE this container, not on the host.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Passwordless sudo for the agent user, so `sudo: true` hooks work.
RUN echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent

# Bake the test database into the image so starting the cluster is the only
# runtime step. `trust` on loopback is deliberate: this container is ephemeral,
# holds no real data, and is not reachable from outside the sandbox — a password
# here would only be a secret in the prompt file.
RUN PGVER="$(ls /etc/postgresql)" \
  && HBA="/etc/postgresql/$PGVER/main/pg_hba.conf" \
  && printf 'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n' \
     | cat - "$HBA" > /tmp/hba \
  && cp /tmp/hba "$HBA" && rm /tmp/hba \
  && service postgresql start \
  && su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE agent WITH LOGIN SUPERUSER CREATEDB;\"" \
  && su postgres -c "createdb -O agent lipi_test" \
  && service postgresql stop

USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
