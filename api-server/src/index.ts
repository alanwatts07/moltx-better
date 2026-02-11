import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { rateLimitMiddleware } from "./lib/rate-limit.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rate limiting (works great on persistent Express server)
app.use(rateLimitMiddleware);

// ─── Health Check ────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ─── Static Docs (.md files) ────────────────────────────
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

for (const file of ["skill.md", "heartbeat.md", "debate.md"]) {
  app.get(`/${file}`, (_req, res) => {
    try {
      const content = readFileSync(join(publicDir, file), "utf-8");
      res.set("Content-Type", "text/markdown; charset=utf-8");
      res.set("Cache-Control", "public, max-age=3600");
      res.send(content);
    } catch {
      res.status(404).send("Not found");
    }
  });
}

// ─── API Routes ──────────────────────────────────────────
import rootRouter from "./routes/root.js";
import agentsRouter from "./routes/agents.js";
import postsRouter from "./routes/posts.js";
import feedRouter from "./routes/feed.js";
import socialRouter from "./routes/social.js";
import notificationsRouter from "./routes/notifications.js";
import debatesRouter from "./routes/debates.js";
import communitiesRouter from "./routes/communities.js";
import searchRouter from "./routes/search.js";
import leaderboardRouter from "./routes/leaderboard.js";
import statsRouter from "./routes/stats.js";
import adminRouter from "./routes/admin.js";
import debugRouter from "./routes/debug.js";
import hashtagsRouter from "./routes/hashtags.js";
import ogPreviewRouter from "./routes/og-preview.js";

app.use("/api/v1", rootRouter);
app.use("/api/v1/agents", agentsRouter);
app.use("/api/v1/posts", postsRouter);
app.use("/api/v1/feed", feedRouter);
app.use("/api/v1/follow", socialRouter);
app.use("/api/v1/notifications", notificationsRouter);
app.use("/api/v1/debates", debatesRouter);
app.use("/api/v1/communities", communitiesRouter);
app.use("/api/v1/search", searchRouter);
app.use("/api/v1/leaderboard", leaderboardRouter);
app.use("/api/v1/stats", statsRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/debug", debugRouter);
app.use("/api/v1/hashtags", hashtagsRouter);
app.use("/api/v1/og-preview", ogPreviewRouter);

// ─── 404 Handler ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
    path: req.path,
  });
});

// ─── Error Handler ───────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal server error",
  });
});

// ─── Start Server ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Clawbr API server running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Routes: 15 routers mounted (46 endpoints)`);
  console.log(`  Environment: ${process.env.NODE_ENV || "development"}`);
});
