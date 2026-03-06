#!/usr/bin/env bash
# Monthly Platform Audit — runs Claude Code CLI to perform a full audit
# Usage: ./scripts/monthly-audit.sh
# Cron:  0 9 1 * * cd /home/morpheus/Hackstuff/moltx_better && ./scripts/monthly-audit.sh >> scripts/audit.log 2>&1

set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/morpheus/Hackstuff/moltx_better}"
DATE=$(date -u +"%Y-%m-%d")
REPORT_DIR="audits"
REPORT_FILE="${REPORT_DIR}/AUDIT_${DATE}.md"
MODEL="${AUDIT_MODEL:-sonnet}"
MAX_BUDGET="${AUDIT_BUDGET:-1.00}"

cd "$REPO_DIR"

echo "=============================================="
echo "  Clawbr Monthly Audit — ${DATE}"
echo "  Model: ${MODEL} | Budget cap: \$${MAX_BUDGET}"
echo "=============================================="

# Check claude CLI exists
if ! command -v claude &> /dev/null; then
    echo "ERROR: claude CLI not found"
    exit 1
fi

# Ensure audits dir exists, remove old report for today if re-running
mkdir -p "$REPORT_DIR"
rm -f "$REPORT_FILE"

AUDIT_PROMPT=$(cat <<'PROMPT'
You are performing an automated weekly platform audit for the Clawbr platform.

## Critical: Discover endpoints before testing

BEFORE running any audit agents, fetch the live API discovery endpoint to get the authoritative list of all endpoints:
  curl https://www.clawbr.org/api/v1

Use ONLY the paths listed in that response when testing. Do not invent or guess endpoint paths — if a path is not in the discovery response, it does not exist and should not be tested.

## Instructions

1. Run 6 parallel Task agents (subagent_type: "general-purpose") to audit all API routes.
   Each agent MUST first fetch https://www.clawbr.org/api/v1 to confirm the real endpoint paths for their section before testing anything.

   **Agent 1 — Agents & Profiles**: Read api-server/src/routes/agents.ts. Using paths from the discovery endpoint, test: GET /agents, GET /agents/neo, GET /agents/neo/vote-score, GET /agents/neo/debates. Verify walletKeyEnc is never in responses. Check for string-vs-number type issues.

   **Agent 2 — Debates & Voting**: Read api-server/src/routes/debates.ts. Using paths from the discovery endpoint, test: GET /debates, GET /debates/:id (pick a real id from the list), GET /debates/hub. Check for stuck debates (votingStatus=pending with null votingEndsAt on completed debates). Test category filter.

   **Agent 3 — Leaderboard & Scoring**: Read api-server/src/routes/leaderboard.ts. Using paths from the discovery endpoint, test ONLY the leaderboard paths that actually exist in the route file. Check response types (numbers vs strings). Verify S3 cache is working (look for cached:true field). Verify grade distribution on judging leaderboard.

   **Agent 4 — Tokens & Tournaments**: Read api-server/src/routes/tokens.ts and api-server/src/routes/tournaments.ts. Using paths from the discovery endpoint, test the token and tournament endpoints that actually exist. Check for stuck tournaments. Cross-check token balance arithmetic for agent "neo".

   **Agent 5 — Documentation**: Read and compare endpoint counts across: api-server/src/routes/root.ts, api-server/skill.json, public/_docs/skill.json, api-server/public/skill.md, src/app/docs/page.tsx, README.md, PLATFORM_PLAN.md. Flag any count mismatches or missing endpoints.

   **Agent 6 — Posts, Communities & Search**: Read api-server/src/routes/feed.ts, search.ts, communities.ts, hashtags.ts. Using paths from the discovery endpoint, test the real paths for feed, search, communities, and hashtags. Check response shapes. Verify search returns results.

2. DO NOT create any posts, agents, debates, or write any data to production. Read-only testing only.

3. After all 6 agents complete, compile their findings into a single markdown audit report.

4. Write the report to the file: audits/AUDIT_DATEPLACEHOLDER.md (use the Write tool — path must start with audits/)

The report format should match previous audits — use tables for findings with severity ratings (Critical/Medium/Low), a summary table, passed checks, and a recommended actions section at the end. Include "Generated automatically by monthly audit script" at the bottom.

5. After writing the report, run: git add audits/AUDIT_DATEPLACEHOLDER.md && git commit -m "docs: automated weekly audit DATEPLACEHOLDER" && git push origin main

Do NOT do anything else. Just the audit and commit.
PROMPT
)

# Replace date placeholder
AUDIT_PROMPT="${AUDIT_PROMPT//DATEPLACEHOLDER/${DATE}}"

echo "[$(date -u +%H:%M:%S)] Starting Claude Code audit..."

PROMPT_FILE="/tmp/audit-prompt-${DATE}.txt"
echo "$AUDIT_PROMPT" > "$PROMPT_FILE"
echo "[$(date -u +%H:%M:%S)] Prompt file: $PROMPT_FILE ($(wc -c < "$PROMPT_FILE") bytes)"

claude --print \
    --dangerously-skip-permissions \
    --model "$MODEL" \
    --max-budget-usd "$MAX_BUDGET" \
    --allowedTools "Task,Read,Glob,Grep,Bash,WebFetch,Write,Edit" \
    --no-session-persistence \
    "$(cat "$PROMPT_FILE")" 2>&1 | tee "/tmp/audit-${DATE}.log"

EXIT_CODE=$?

echo ""
echo "[$(date -u +%H:%M:%S)] Claude exited with code ${EXIT_CODE}"

# Verify report was created
if [ -f "$REPORT_FILE" ]; then
    LINES=$(wc -l < "$REPORT_FILE")
    echo "[$(date -u +%H:%M:%S)] Report written: ${REPORT_FILE} (${LINES} lines)"
else
    echo "[$(date -u +%H:%M:%S)] WARNING: Report file not found. Check /tmp/audit-${DATE}.log"
fi

echo "=============================================="
echo "  Audit complete"
echo "=============================================="
