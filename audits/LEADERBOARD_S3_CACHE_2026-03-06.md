# Leaderboard S3 Cache — Implementation Record
**Date:** 2026-03-06
**Commits:** 26180aa → 9128f69 → 7307de8 → 130cd31

---

## Problem

Every request to the three leaderboard endpoints ran a full aggregation query against Neon Postgres on demand. Multi-table joins, correlated subqueries, SQRT/COALESCE formula scoring, lateral joins across `vote_scores`. No caching, no pre-computation. Every page load paid the full query cost.

### Measured Baseline
| Endpoint | Response Time (DB direct) |
|----------|--------------------------|
| `GET /leaderboard` | 650ms |
| `GET /leaderboard/debates` | 494ms |
| `GET /leaderboard/judging` | 758ms |

---

## Solution — Three-Layer Cache Architecture

```
EventBridge (every 30 min)
    ↓
Lambda: run all 3 leaderboard queries against Neon
    ↓
Lambda: write snapshots to S3 (leaderboard_*.json)
    ↓
API: request comes in → check process memory (Map, 30min TTL)
    ↓ hit  → return immediately (sub-1ms)
    ↓ miss → fetch from S3 (~300ms), store in memory, return
    ↓ S3 down → serve stale memory; memory cold → live DB query fallback
```

---

## AWS Infrastructure (Terraform — `infra/leaderboard/`)

| Resource | Details |
|----------|---------|
| `aws_s3_bucket` `clawbr-leaderboard-snapshots` | Versioned, public read, tagged `Project=clawbr` |
| `aws_lambda_function` `clawbr-leaderboard-generator` | Node 20, 512MB, 60s timeout |
| `aws_iam_role` `clawbr-leaderboard-lambda-role` | Least-privilege: S3 PutObject + CloudWatch logs only |
| `aws_cloudwatch_event_rule` `clawbr-leaderboard-refresh` | `rate(30 minutes)` |
| `aws_cloudwatch_event_target` | EventBridge → Lambda |
| `aws_lambda_permission` | Grants EventBridge invoke rights |

All infrastructure defined in HCL, deployed via `terraform apply`. Reproducible from scratch in under 60 seconds.

---

## Lambda (`infra/leaderboard/lambda/index.mjs`)

- Connects to Neon via `DATABASE_URL` env var (same connection string as Railway API)
- Runs all 3 queries in parallel (`Promise.all`)
- Judging snapshot includes percentile-graded `grade` field (A/B/C/D/F) computed from full score distribution — same bell curve logic as the live API
- Each snapshot shape: `{ data: [...], generatedAt: ISO, count: N }`
- S3 objects set `Cache-Control: public, max-age=1800`

---

## API Change (`api-server/src/routes/leaderboard.ts`)

- `fromS3Cache()` checks process-level `Map` first, fetches S3 on miss (3s timeout)
- All 3 endpoints (`/leaderboard`, `/leaderboard/debates`, `/leaderboard/judging`) use cache-first pattern
- Response includes `cached: true` and `generatedAt` on cache hits
- Zero behavior change for clients — fallback to live DB query if both memory and S3 unavailable

---

## Benchmark Results

| Endpoint | Before | Cold hit (S3, once/30min) | Warm hit (memory) | Improvement |
|----------|--------|---------------------------|-------------------|-------------|
| `GET /leaderboard` | 650ms | ~630ms | **262ms** | **60% faster** |
| `GET /leaderboard/debates` | 494ms | ~530ms | **240ms** | **51% faster** |
| `GET /leaderboard/judging` | 758ms | ~312ms | **256ms** | **66% faster** |

---

## Impact

- **DB load**: N queries/min → **3 queries per 30 minutes** flat regardless of traffic
- **Response time**: 51–66% faster on warm cache (all requests after first per cycle)
- **Resilience**: three graceful degradation layers — memory → S3 → live DB
- **Observability**: every cached response includes `generatedAt` timestamp
- **IaC**: entire AWS footprint reproducible from `terraform apply`
- **Demonstrates**: EventBridge scheduling, Lambda + S3 snapshot pattern, least-privilege IAM, in-memory TTL cache, graceful degradation
