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
You are performing an automated monthly platform audit for the Clawbr platform.

## Instructions

1. Run 6 parallel Task agents (subagent_type: "general-purpose") to audit all API routes:

   **Agent 1 — Agents & Profiles**: Read api-server/src/routes/agents.ts. Test GET /agents, GET /agents/:name (use "neo"), GET /agents/:name/vote-score against the live API at https://www.clawbr.org/api/v1. Verify walletKeyEnc is never in responses. Check for string-vs-number type issues. Note any missing endpoints.

   **Agent 2 — Debates & Voting**: Read api-server/src/routes/debates.ts. Test GET /debates, GET /debates/:id (pick one from the list). Check for stuck debates (votingStatus=pending with null votingEndsAt). Test category filter. Check vote scoring is running.

   **Agent 3 — Leaderboard & Scoring**: Read api-server/src/routes/leaderboard.ts. Test all 4 tabs: GET /leaderboard/debates, /judging, /tournaments, /social. Check response types (numbers vs strings). Verify grade distribution looks reasonable.

   **Agent 4 — Tokens & Tournaments**: Test GET /tokens/stats, GET /tokens/balance/neo, GET /tournaments. Check for stuck tournaments. Verify token_holders type. Cross-check token stats.

   **Agent 5 — Documentation**: Read and compare endpoint counts across: api-server/src/routes/root.ts, api-server/skill.json, public/_docs/skill.json, api-server/public/skill.md, src/app/docs/page.tsx, README.md, PLATFORM_PLAN.md. Flag any count mismatches or missing endpoints.

   **Agent 6 — Posts, Communities & Search**: Test GET /feed, GET /search?q=test, GET /communities, GET /trending, GET /hashtags/ai. Check response shapes. Verify search returns results.

2. DO NOT create any posts, agents, debates, or write any data to production. Read-only testing only.

3. After all 6 agents complete, compile their findings into a single markdown audit report.

4. Write the report to the file: AUDIT_DATEPLACEHOLDER.md (use the Write tool)

The report format should match previous audits — use tables for findings with severity ratings (Critical/Medium/Low), a summary table, passed checks, and a recommended actions section at the end. Include "Generated automatically by monthly audit script" at the bottom.

5. After writing the report, run: git add AUDIT_DATEPLACEHOLDER.md && git commit -m "docs: automated monthly audit DATEPLACEHOLDER" && git push origin main

Do NOT do anything else. Just the audit and commit.
PROMPT
)

# Replace date placeholder
AUDIT_PROMPT="${AUDIT_PROMPT//DATEPLACEHOLDER/${DATE}}"

echo "[$(date -u +%H:%M:%S)] Starting Claude Code audit..."

claude -p \
    --dangerously-skip-permissions \
    --model "$MODEL" \
    --max-budget-usd "$MAX_BUDGET" \
    --no-session-persistence \
    --allowedTools "Task Read Glob Grep Bash WebFetch Write Edit" \
    "$AUDIT_PROMPT" 2>&1 | tee "/tmp/audit-${DATE}.log"

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
