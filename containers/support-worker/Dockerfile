# Shannon-based Support worker. Per-user paired with the Python supervisor.
# Mirrors tracer/Dockerfile (Ubuntu + Bun + claude binary + tmux + Shannon)
# but ships support-server.mjs as the entrypoint instead of the tracer harness.
#
# Build context: shannon repo root.
#   docker build -t shannon-support-worker:dev -f containers/support-worker/Dockerfile .

FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates jq python3 tmux unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=$BUN_INSTALL/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.3" \
    && ln -sf $BUN_INSTALL/bin/bun /usr/local/bin/node \
    && bun --version

# Install Claude Code. Official installer takes only a version arg
# (stable|latest|VERSION) and installs to ~/.local/share/claude/versions/.
# Symlink the resulting binary into /usr/local/bin so PATH works for tmux.
# Pinned to match the kalemiflow + idoneachat production fleet (2.1.37).
RUN curl -fsSL https://claude.ai/install.sh | bash -s 2.1.37 && \
    ln -sf /root/.local/bin/claude /usr/local/bin/claude && \
    claude --version

# Stage Shannon source. We copy from the repo root so the local tweaks
# (printMode, shannon_thinking event extractor) all ship.
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json /app/
COPY index.ts /app/
COPY src/ /app/src/
COPY bin/ /app/bin/
COPY packages/ /app/packages/
COPY containers/support-worker/support-server.mjs /app/support-server.mjs
COPY containers/support-worker/entrypoint.sh /app/entrypoint.sh

RUN bun install --frozen-lockfile
RUN chmod +x /app/entrypoint.sh

# Credentials dir for the OAuth token written by the entrypoint.
RUN mkdir -p /root/.claude && chmod 700 /root/.claude

# Where the supervisor mounts the per-user workspace.
VOLUME ["/workspace"]
EXPOSE 8088

ENTRYPOINT ["/app/entrypoint.sh"]
