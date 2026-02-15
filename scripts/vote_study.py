#!/usr/bin/env python3
"""Analyze voting patterns on the Clawbr debate platform."""

import json
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

import requests

BASE = "https://moltxbetter.vercel.app/api/v1"


def fetch_all_completed_debates():
    """Fetch all completed debates with pagination."""
    debates = []
    offset = 0
    limit = 200
    while True:
        url = f"{BASE}/debates?status=completed&limit={limit}&offset={offset}"
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        data = r.json()
        batch = data.get("debates", [])
        debates.extend(batch)
        pag = data.get("pagination", {})
        if len(batch) < limit:
            break
        offset += limit
    return debates


def fetch_debate_detail(slug):
    """Fetch full debate detail by slug."""
    url = f"{BASE}/debates/{slug}"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    print("Fetching completed debates...", file=sys.stderr)
    debates_list = fetch_all_completed_debates()
    print(f"Found {len(debates_list)} completed debates", file=sys.stderr)

    # Track stats
    challenger_wins = 0
    opponent_wins = 0
    category_stats = defaultdict(lambda: {"challenger": 0, "opponent": 0, "total": 0})
    voter_stats = defaultdict(lambda: {"challenger": 0, "opponent": 0, "total": 0})
    debates_with_votes = 0
    debates_analyzed = 0

    for i, d in enumerate(debates_list):
        slug = d.get("slug") or d.get("id")
        if not slug:
            continue

        try:
            detail = fetch_debate_detail(slug)
        except Exception as e:
            print(f"  Error fetching {slug}: {e}", file=sys.stderr)
            continue

        votes = detail.get("votes", {})
        total_votes = votes.get("total", 0)

        if total_votes == 0:
            continue

        debates_with_votes += 1
        debates_analyzed += 1

        # Determine winner by votes
        ch_votes = votes.get("challenger", 0)
        op_votes = votes.get("opponent", 0)

        if ch_votes > op_votes:
            challenger_wins += 1
            winner_side = "challenger"
        elif op_votes > ch_votes:
            opponent_wins += 1
            winner_side = "opponent"
        else:
            # Tie — count for neither side win, but still count votes
            winner_side = "tie"

        # Category breakdown
        cat = detail.get("category") or "Other"
        if winner_side == "challenger":
            category_stats[cat]["challenger"] += 1
        elif winner_side == "opponent":
            category_stats[cat]["opponent"] += 1
        category_stats[cat]["total"] += 1

        # Individual voter patterns
        vote_details = votes.get("details", [])
        for v in vote_details:
            voter = v.get("voter", {})
            name = voter.get("name", "unknown")
            side = v.get("side", "")
            if side in ("challenger", "opponent"):
                voter_stats[name][side] += 1
                voter_stats[name]["total"] += 1

        if (i + 1) % 20 == 0:
            print(f"  Processed {i+1}/{len(debates_list)}...", file=sys.stderr)
        time.sleep(0.05)  # Be gentle

    # Build category breakdown sorted by challenger win %
    categories = []
    for cat, stats in sorted(category_stats.items(), key=lambda x: x[1]["total"], reverse=True):
        if stats["total"] == 0:
            continue
        pct = round(stats["challenger"] / stats["total"] * 100) if stats["total"] > 0 else 0
        categories.append({
            "name": cat,
            "challengerWins": stats["challenger"],
            "opponentWins": stats["opponent"],
            "total": stats["total"],
            "challengerPct": pct,
        })

    # Find most unbalanced and most balanced
    cats_with_enough = [c for c in categories if c["total"] >= 3]
    most_unbalanced = max(cats_with_enough, key=lambda c: abs(c["challengerPct"] - 50)) if cats_with_enough else None
    most_balanced = min(cats_with_enough, key=lambda c: abs(c["challengerPct"] - 50)) if cats_with_enough else None

    # Build voter breakdown sorted by challenger %
    voters = []
    for name, stats in voter_stats.items():
        if stats["total"] == 0:
            continue
        pct = round(stats["challenger"] / stats["total"] * 100)
        voters.append({
            "name": name,
            "challenger": stats["challenger"],
            "opponent": stats["opponent"],
            "total": stats["total"],
            "challengerPct": pct,
        })
    voters.sort(key=lambda v: v["challengerPct"], reverse=True)

    total_decided = challenger_wins + opponent_wins
    overall_pct = round(challenger_wins / total_decided * 100) if total_decided > 0 else 0

    # Voter bias summary
    high_bias = [v for v in voters if v["total"] >= 5 and v["challengerPct"] >= 70]
    balanced = [v for v in voters if v["total"] >= 5 and 45 <= v["challengerPct"] <= 55]
    active_voters = [v for v in voters if v["total"] >= 5]

    result = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "totalDebates": len(debates_list),
        "debatesWithVotes": debates_with_votes,
        "overallChallengerWins": challenger_wins,
        "overallOpponentWins": opponent_wins,
        "overallChallengerPct": overall_pct,
        "categories": categories,
        "mostUnbalanced": most_unbalanced,
        "mostBalanced": most_balanced,
        "voters": voters,
        "voterSummary": {
            "totalActiveVoters": len(active_voters),
            "highBiasCount": len(high_bias),
            "balancedCount": len(balanced),
            "highBiasRange": f"{min(v['challengerPct'] for v in high_bias)}-{max(v['challengerPct'] for v in high_bias)}%" if high_bias else "N/A",
        },
    }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
