#!/bin/bash
# Entrypoint for shannon-support-worker. Stages OAuth credentials and the
# ~/.claude.json first-run state so claude doesn't park at the theme picker
# or workspace-trust dialog inside the container, then exec's the Bun server.
set -euo pipefail

if [ -z "${CLAUDE_OAUTH_TOKEN:-}" ]; then
  echo "ERROR: CLAUDE_OAUTH_TOKEN env var is required." >&2
  echo "  Grab one from the prod token service via SSH, e.g.:" >&2
  echo "  ssh root@195.201.62.172 'curl -sS -X POST http://claude-token-service:4852/lease -H \"X-API-Key: \$TOKEN_SERVICE_API_KEY\" -d \"{\\\"allow_shared\\\":true}\"' | jq -r '.access_token'" >&2
  exit 1
fi

# Build the credentials file. accessToken is what we got; refreshToken is left
# empty for this first cut (no rotation yet); expiresAt is a safe future stamp.
EXPIRES_AT=$(python3 -c "import time; print(int((time.time()+50*60)*1000))")
cat > /root/.claude/.credentials.json <<EOF
{
  "claudeAiOauth": {
    "accessToken": "${CLAUDE_OAUTH_TOKEN}",
    "refreshToken": "",
    "expiresAt": ${EXPIRES_AT},
    "scopes": ["user:inference"],
    "subscriptionType": "${CLAUDE_SUBSCRIPTION_TYPE:-pro}"
  }
}
EOF
chmod 600 /root/.claude/.credentials.json

# Baseline user settings so claude doesn't sit at the theme picker / trust
# dialog on first run inside the container, and so showThinkingSummaries is on.
cat > /root/.claude/settings.json <<'EOF'
{
  "theme": "dark",
  "skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true,
  "showThinkingSummaries": true
}
EOF
chmod 600 /root/.claude/settings.json

# State file (NOT settings.json) is what gates the first-run theme picker
# AND the workspace-trust dialog. Lives at ~/.claude.json (at $HOME, not
# inside ~/.claude/). hasCompletedOnboarding gates the theme picker;
# projects.<cwd>.hasTrustDialogAccepted gates the workspace trust dialog.
cat > /root/.claude.json <<'EOF'
{
  "hasCompletedOnboarding": true,
  "hasCompletedAuthFlow": true,
  "hasCompletedProjectOnboarding": true,
  "theme": "dark",
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasClaudeMdExternalIncludesApproved": true,
      "hasClaudeMdExternalIncludesWarningShown": true,
      "projectOnboardingSeenCount": 1
    }
  }
}
EOF
chmod 600 /root/.claude.json

# Verify the per-user workspace is mounted. The supervisor mounts the host
# workspace dir at /workspace; if missing, the agent has nowhere to read/write.
if [ ! -d /workspace ]; then
  echo "ERROR: /workspace not mounted." >&2
  exit 1
fi

echo "=== shannon-support-worker boot ==="
echo "claude version:    $(claude --version | head -1)"
echo "bun version:       $(bun --version)"
echo "tmux version:      $(tmux -V)"
echo "credentials path:  /root/.claude/.credentials.json ($(stat -c%a /root/.claude/.credentials.json) bytes=$(stat -c%s /root/.claude/.credentials.json))"
echo "workspace:         /workspace ($(ls /workspace 2>/dev/null | wc -l) entries)"
echo

# Hand off to the Bun HTTP server. Use exec so signals reach the Bun process
# directly (so docker stop / kill propagate cleanly to in-flight Shannon turns).
exec bun /app/support-server.mjs
