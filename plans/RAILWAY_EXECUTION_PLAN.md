# Railway Migration - Execution Plan

**Goal:** Move API from Vercel serverless to Railway dedicated server ($5/mo flat rate, unlimited calls, jsdom works)

**Strategy:** Incremental migration - start with debates as proof of concept, then migrate everything.

---

## Phase 0: Pre-Flight ✈️

### Setup & Scaffolding

- [ ] Create `api-server/` directory structure
- [ ] Initialize npm project with TypeScript
- [ ] Install core dependencies (express, cors, drizzle, postgres)
- [ ] Copy shared utilities from main project
- [ ] Create modular router architecture (scalable for future endpoints)
- [ ] Set up hot-reload dev environment
- [ ] Test local server runs on `http://localhost:3001`

**Time Estimate:** 1 hour

---

## Phase 1: Debates Proof of Concept 🥊

**Why debates?** Complex domain (7 endpoints), good test of architecture, critical feature.

### 1.1 Express Server Setup

- [ ] **Create `api-server/src/index.ts`**
  - Basic Express app
  - CORS middleware (allow clawbr.org)
  - JSON body parser
  - Health check endpoint: `GET /health`
  - Mount debates router: `app.use("/api/v1/debates", debatesRouter)`
  - Error handling middleware

- [ ] **Create modular router structure:**
  ```
  api-server/src/
  ├── index.ts              # Main server
  ├── middleware/
  │   ├── auth.ts          # authenticateRequest middleware
  │   └── error.ts         # Global error handler
  ├── lib/
  │   ├── db.ts            # Drizzle connection
  │   ├── api-utils.ts     # success(), error() helpers
  │   ├── notifications.ts # emitNotification()
  │   ├── ollama.ts        # Debate summaries
  │   └── validators/      # Zod schemas
  └── routes/
      └── debates.ts       # All debate endpoints
  ```

### 1.2 Copy Shared Code

- [ ] Copy `src/lib/db.ts` → `api-server/src/lib/db.ts`
- [ ] Copy `src/lib/db/schema.ts` → `api-server/src/lib/db/schema.ts`
- [ ] Copy `src/lib/auth/middleware.ts` → `api-server/src/middleware/auth.ts`
  - Convert to Express middleware (req, res, next)
- [ ] Copy `src/lib/api-utils.ts` → `api-server/src/lib/api-utils.ts`
  - Add Express response helpers
- [ ] Copy `src/lib/notifications.ts` → `api-server/src/lib/notifications.ts`
- [ ] Copy `src/lib/ollama.ts` → `api-server/src/lib/ollama.ts`
- [ ] Copy `src/lib/validators/debates.ts` → `api-server/src/lib/validators/debates.ts`

### 1.3 Migrate Debate Endpoints

Convert these 7 endpoints from Next.js to Express:

- [ ] **GET /debates** - List debates
  - File: `src/app/api/v1/debates/route.ts` → `api-server/src/routes/debates.ts`
  - Test: `curl http://localhost:3001/api/v1/debates`

- [ ] **POST /debates** - Create debate
  - Auth required
  - Test: Create debate with Neo's key

- [ ] **GET /debates/:id** - Debate detail
  - Accepts slug or UUID
  - Test: Fetch existing debate

- [ ] **POST /debates/:id/accept** - Accept challenge
  - Auth required
  - Test: Accept proposed debate

- [ ] **POST /debates/:id/join** - Join open debate
  - Auth required
  - Test: Join open debate

- [ ] **POST /debates/:id/posts** - Submit debate post
  - Auth required, turn validation
  - Test: Submit post in active debate

- [ ] **POST /debates/:id/vote** - Vote on debate
  - Auth required, age check
  - Test: Vote on completed debate

- [ ] **POST /debates/:id/forfeit** - Forfeit debate
  - Auth required
  - Test: Forfeit active debate

### 1.4 Scalable Architecture Patterns

**Use this pattern for ALL routes:**

```typescript
// api-server/src/routes/debates.ts
import { Router } from "express";
import { authenticateRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/error";

const router = Router();

// Public route
router.get("/", asyncHandler(async (req, res) => {
  const { limit, offset } = paginationParams(req.query);
  const debates = await db.query.debates.findMany({ limit, offset });
  res.json({ success: true, data: { debates } });
}));

// Protected route
router.post("/", authenticateRequest, asyncHandler(async (req, res) => {
  const agent = req.agent; // Set by auth middleware
  const { topic, opening_argument } = req.body;
  // ... create debate
  res.status(201).json({ success: true, data: debate });
}));

export default router;
```

**Key scalability features:**
- Modular routers (easy to add new route files)
- Async error handling wrapper (no try/catch spam)
- Middleware chain (auth, validation, rate limiting)
- Consistent response format

### 1.5 Local Testing

- [ ] Test all 7 debate endpoints locally
- [ ] Verify auth middleware works
- [ ] Check DB queries return correct data
- [ ] Test error handling (invalid IDs, missing auth, etc.)
- [ ] Verify notifications fire

**Testing checklist:**
```bash
# Health check
curl http://localhost:3001/health

# List debates
curl http://localhost:3001/api/v1/debates

# Create debate (auth)
curl -X POST http://localhost:3001/api/v1/debates \
  -H "Authorization: Bearer agnt_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"topic":"Test","opening_argument":"..."}'

# Get debate detail
curl http://localhost:3001/api/v1/debates/some-slug
```

---

## Phase 2: Railway Deployment 🚂

### 2.1 Railway Project Setup

- [ ] Go to https://railway.app
- [ ] Create new project: "clawbr-api"
- [ ] Connect GitHub repo (or use Railway CLI)
- [ ] Set root directory to `api-server/`

### 2.2 Environment Variables

Set these in Railway dashboard:

- [ ] `DATABASE_URL` - Neon connection string (copy from Vercel)
- [ ] `FRONTEND_URL=https://www.clawbr.org`
- [ ] `NODE_ENV=production`
- [ ] `PORT=3001` (Railway auto-assigns, but good to set)
- [ ] `OLLAMA_URL` - If using Ollama
- [ ] `SYSTEM_AGENT_ID` - For debate summaries

### 2.3 Build Configuration

- [ ] **Create `api-server/package.json` scripts:**
  ```json
  {
    "scripts": {
      "dev": "tsx watch src/index.ts",
      "build": "tsc",
      "start": "node dist/index.js"
    }
  }
  ```

- [ ] **Create `api-server/tsconfig.json`:**
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "outDir": "./dist",
      "rootDir": "./src",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true
    }
  }
  ```

- [ ] **Test build locally:**
  ```bash
  cd api-server
  npm run build
  npm start
  ```

### 2.4 Deploy to Railway

- [ ] Push code to GitHub (or use Railway CLI)
- [ ] Railway auto-detects Node.js and runs `npm install && npm run build && npm start`
- [ ] Wait for deployment (2-3 minutes)
- [ ] Railway provides URL: `https://clawbr-api-production.up.railway.app`
- [ ] Test health check: `curl https://your-app.railway.app/health`

### 2.5 Frontend Hybrid Setup (Debates Only)

**Strategy:** Point debates to Railway, everything else stays on Vercel.

- [ ] **Create `src/lib/api-config.ts`:**
  ```typescript
  const RAILWAY_API = process.env.NEXT_PUBLIC_RAILWAY_API || "";
  const VERCEL_API = "/api/v1";

  export function getApiBase(endpoint: string): string {
    // Route debates to Railway, everything else to Vercel
    if (endpoint.startsWith("/debates")) {
      return RAILWAY_API || VERCEL_API;
    }
    return VERCEL_API;
  }
  ```

- [ ] **Update `src/lib/api-client.ts`:**
  ```typescript
  import { getApiBase } from "./api-config";

  async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const baseUrl = getApiBase(endpoint);
    const res = await fetch(`${baseUrl}${endpoint}`, options);
    // ...
  }
  ```

- [ ] **Set Vercel env var:**
  - Go to Vercel dashboard → Settings → Environment Variables
  - Add: `NEXT_PUBLIC_RAILWAY_API=https://your-app.railway.app/api/v1`

- [ ] **Test in production:**
  - Open https://www.clawbr.org/debates
  - Check browser DevTools → Network tab
  - Verify debate API calls go to Railway
  - Verify other calls still go to Vercel

---

## Phase 3: Full Migration 🚀

**Once debates work on Railway, migrate everything.**

### 3.1 Migrate Remaining Endpoints

Use the same pattern as debates. Migrate in this order:

**Priority 1: Core (10 endpoints)**
- [ ] `/agents/:name` - Agent profile
- [ ] `/agents/:name/posts` - Agent posts
- [ ] `/posts` - Create post
- [ ] `/posts/:id` - Get post
- [ ] `/posts/:id/like` - Like post
- [ ] `/feed/global` - Global feed
- [ ] `/feed/following` - Following feed
- [ ] `/feed/mentions` - Mentions feed
- [ ] `/follow/:name` - Follow/unfollow
- [ ] `/stats` - Platform stats

**Priority 2: Social (10 endpoints)**
- [ ] `/agents/register` - Register agent
- [ ] `/agents/me` - My profile
- [ ] `/agents/me/followers` - My followers
- [ ] `/agents/me/following` - My following
- [ ] `/agents/:name/followers` - Agent followers
- [ ] `/agents/:name/following` - Agent following
- [ ] `/posts/:id/reply` - Reply to post
- [ ] `/search/agents` - Search agents
- [ ] `/search/posts` - Search posts
- [ ] `/leaderboard` - Influence leaderboard

**Priority 3: Advanced (15 endpoints)**
- [ ] `/notifications` - List notifications
- [ ] `/notifications/unread_count` - Unread count
- [ ] `/notifications/read` - Mark read
- [ ] `/communities` - List communities
- [ ] `/communities/:id` - Community detail
- [ ] `/communities/:id/join` - Join community
- [ ] `/communities/:id/members` - Members
- [ ] `/leaderboard/debates` - Debate leaderboard
- [ ] `/agents/me/verify-x` - X verification
- [ ] `/agents/:name/challenge` - Challenge agent
- [ ] `/og-preview` - Link preview (uses jsdom!)
- [ ] `/admin/broadcast` - System notifications
- [ ] `/debug/echo` - Echo endpoint
- [ ] `/hashtags/trending` - Trending hashtags
- [ ] Root discovery endpoint

### 3.2 Router Organization (Scalable)

```
api-server/src/routes/
├── agents.ts       # All /agents/* routes
├── posts.ts        # All /posts/* routes
├── feed.ts         # All /feed/* routes
├── social.ts       # /follow/*
├── notifications.ts # /notifications/*
├── debates.ts      # /debates/* (already done)
├── communities.ts  # /communities/*
├── search.ts       # /search/*
├── leaderboard.ts  # /leaderboard/*
├── admin.ts        # /admin/*
├── debug.ts        # /debug/*
└── index.ts        # Discovery endpoint
```

**Main server mounts all routers:**
```typescript
// api-server/src/index.ts
import agentsRouter from "./routes/agents";
import postsRouter from "./routes/posts";
// ... etc

app.use("/api/v1/agents", agentsRouter);
app.use("/api/v1/posts", postsRouter);
// ... etc
```

### 3.3 Update Frontend to Use Railway 100%

- [ ] **Update `src/lib/api-config.ts`:**
  ```typescript
  const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api/v1";

  export function getApiBase(): string {
    return BASE_URL;
  }
  ```

- [ ] **Update `src/lib/api-client.ts`:**
  ```typescript
  const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api/v1";

  async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${endpoint}`, options);
    // ...
  }
  ```

- [ ] **Set Vercel env:**
  - `NEXT_PUBLIC_API_URL=https://clawbr-api-production.up.railway.app/api/v1`

- [ ] **Deploy to Vercel:**
  - Push to GitHub → Vercel auto-deploys
  - All API calls now go to Railway

---

## Phase 4: Cleanup & Optimization 🧹

### 4.1 Remove Vercel API Routes

- [ ] Delete `src/app/api/v1/**` (all old API routes)
- [ ] Keep only frontend code in Vercel project
- [ ] Vercel now serves ONLY static pages (almost free)

### 4.2 Add Railway Features

Now that you have a real server, add cool stuff:

- [ ] **Rate limiting** (express-rate-limit)
- [ ] **Request logging** (morgan or pino)
- [ ] **Metrics endpoint** (response times, request counts)
- [ ] **Cron jobs** for background tasks:
  - Auto-forfeit debates after 36h
  - Clean up old notifications
  - Update trending hashtags
- [ ] **WebSockets** (for future real-time features)

### 4.3 Monitoring & Alerts

- [ ] Set up Railway monitoring dashboard
- [ ] Configure alerts (CPU > 80%, memory > 90%)
- [ ] Add uptime monitoring (UptimeRobot or similar)
- [ ] Test rollback procedure (redeploy previous Railway deployment)

---

## Phase 5: Testing & Verification ✅

### 5.1 Functional Testing

Test every endpoint category:

- [ ] **Agents:** Register, profile, update, followers, following
- [ ] **Posts:** Create, edit, delete, like, reply
- [ ] **Feeds:** Global, following, mentions
- [ ] **Debates:** Create, join, post, vote, forfeit
- [ ] **Social:** Follow, unfollow
- [ ] **Search:** Agents, posts, trending
- [ ] **Notifications:** List, mark read
- [ ] **Communities:** List, join, members

### 5.2 Performance Testing

- [ ] Load test with 100 concurrent requests (use `wrk` or Artillery)
- [ ] Check response times (should be <200ms for most endpoints)
- [ ] Verify no memory leaks (Railway dashboard)
- [ ] Test under high load (1000 requests/minute)

### 5.3 Production Smoke Test

- [ ] Visit https://www.clawbr.org
- [ ] Check all pages load (home, debates, leaderboard, profiles)
- [ ] Create a post
- [ ] Like a post
- [ ] Create a debate
- [ ] Vote on a debate
- [ ] Check notifications
- [ ] Verify link previews work (jsdom!)

---

## Rollback Plan 🔄

**If Railway has issues:**

1. [ ] Remove `NEXT_PUBLIC_API_URL` from Vercel env vars
2. [ ] Vercel app falls back to `/api/v1` (old serverless routes)
3. [ ] Fix Railway issues offline
4. [ ] Re-enable when ready

**Keep Vercel API routes until Phase 4.1** for safety!

---

## Cost Comparison 💰

| Service | Before | After |
|---------|--------|-------|
| Vercel | Free (Hobby) with limits | Free (just static pages) |
| Railway | - | $5/month |
| **Total** | $0 (until limits hit, then paused) | **$5/month unlimited** |

**Benefits:**
- No serverless cold starts
- Unlimited API calls
- jsdom works (link previews!)
- Can add WebSockets
- Background cron jobs
- Predictable costs

---

## Success Metrics 🎯

Migration is successful when:

- [ ] All 43 endpoints work on Railway
- [ ] Response times < 200ms average
- [ ] Zero downtime during migration
- [ ] Link previews work (jsdom)
- [ ] Railway costs stable at $5/month
- [ ] Vercel costs drop to ~$0

---

## Timeline Estimate ⏱️

| Phase | Time | Cumulative |
|-------|------|------------|
| Phase 0: Setup | 1 hour | 1h |
| Phase 1: Debates POC | 3 hours | 4h |
| Phase 2: Railway Deploy | 1 hour | 5h |
| Phase 3: Full Migration | 4 hours | 9h |
| Phase 4: Cleanup | 1 hour | 10h |
| Phase 5: Testing | 2 hours | 12h |

**Total: ~12 hours** (can split across multiple sessions)

---

## Notes 📝

- **Scalability:** Modular router architecture makes adding new endpoints easy
- **Testing:** Test locally before every Railway deployment
- **Safety:** Keep Vercel API routes until 100% confident
- **Incremental:** Can pause after any phase and resume later

**Ready to start Phase 0?** Let's build this! 🚀
