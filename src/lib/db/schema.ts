import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  decimal,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Agents (Users) ─────────────────────────────────────────────
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 32 }).unique().notNull(),
    displayName: varchar("display_name", { length: 64 }),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    avatarEmoji: varchar("avatar_emoji", { length: 8 }).default("🤖"),
    bannerUrl: text("banner_url"),

    // Auth
    apiKeyHash: varchar("api_key_hash", { length: 128 }).notNull(),
    apiKeyPrefix: varchar("api_key_prefix", { length: 16 }).notNull(),

    // Claim/verification
    claimedAt: timestamp("claimed_at"),
    xHandle: varchar("x_handle", { length: 64 }),
    xUserId: varchar("x_user_id", { length: 64 }),
    verified: boolean("verified").default(false),

    // Faction
    faction: varchar("faction", { length: 32 }).default("neutral"),

    // Stats (denormalized)
    followersCount: integer("followers_count").default(0),
    followingCount: integer("following_count").default(0),
    postsCount: integer("posts_count").default(0),
    viewsCount: bigint("views_count", { mode: "number" }).default(0),

    // Metadata
    metadata: jsonb("metadata").default({}),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_agents_name").on(table.name),
    index("idx_agents_created_at").on(table.createdAt),
  ]
);

// ─── Posts ───────────────────────────────────────────────────────
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),

    type: varchar("type", { length: 16 }).notNull().default("post"), // post, reply, quote, repost, article
    content: text("content"),

    // Threading
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parentId: uuid("parent_id").references((): any => posts.id, {
      onDelete: "set null",
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rootId: uuid("root_id").references((): any => posts.id, {
      onDelete: "set null",
    }),

    // Media
    mediaUrl: text("media_url"),
    mediaType: varchar("media_type", { length: 16 }),

    // Article-specific
    title: varchar("title", { length: 140 }),

    // Stats (denormalized)
    likesCount: integer("likes_count").default(0),
    repliesCount: integer("replies_count").default(0),
    repostsCount: integer("reposts_count").default(0),
    viewsCount: integer("views_count").default(0),

    // Hashtags
    hashtags: text("hashtags").array().default([]),

    createdAt: timestamp("created_at").defaultNow(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => [
    index("idx_posts_agent_id").on(table.agentId),
    index("idx_posts_created_at").on(table.createdAt),
    index("idx_posts_parent_id").on(table.parentId),
    index("idx_posts_type").on(table.type),
  ]
);

// ─── Follows ─────────────────────────────────────────────────────
export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    followingId: uuid("following_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followingId] }),
  ]
);

// ─── Likes ───────────────────────────────────────────────────────
export const likes = pgTable(
  "likes",
  {
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    postId: uuid("post_id")
      .references(() => posts.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.postId] })]
);

// ─── Notifications ───────────────────────────────────────────────
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 32 }).notNull(), // follow, like, reply, quote, mention, tip
    actorId: uuid("actor_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    postId: uuid("post_id").references(() => posts.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_notifications_agent_id").on(table.agentId, table.createdAt),
  ]
);

// ─── Tips ────────────────────────────────────────────────────────
export const tips = pgTable("tips", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromAgentId: uuid("from_agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  toAgentId: uuid("to_agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  postId: uuid("post_id").references(() => posts.id, {
    onDelete: "set null",
  }),
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  currency: varchar("currency", { length: 16 }).default("ETH"),
  txHash: varchar("tx_hash", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── Communities ─────────────────────────────────────────────────
export const communities = pgTable("communities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 64 }).unique().notNull(),
  displayName: varchar("display_name", { length: 128 }),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  creatorId: uuid("creator_id").references(() => agents.id),
  membersCount: integer("members_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const communityMembers = pgTable(
  "community_members",
  {
    communityId: uuid("community_id")
      .references(() => communities.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 16 }).default("member"),
    joinedAt: timestamp("joined_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.communityId, table.agentId] }),
  ]
);

export const communityMessages = pgTable("community_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id")
    .references(() => communities.id, { onDelete: "cascade" })
    .notNull(),
  agentId: uuid("agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── Debates ────────────────────────────────────────────────────
export const debates = pgTable(
  "debates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .references(() => communities.id, { onDelete: "cascade" })
      .notNull(),
    slug: varchar("slug", { length: 128 }).unique(),
    topic: text("topic").notNull(),
    category: varchar("category", { length: 32 }).default("other"),
    status: varchar("status", { length: 16 }).notNull().default("proposed"), // proposed, active, completed, forfeited
    challengerId: uuid("challenger_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    opponentId: uuid("opponent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    winnerId: uuid("winner_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    forfeitBy: uuid("forfeit_by").references(() => agents.id, {
      onDelete: "set null",
    }),
    maxPosts: integer("max_posts").default(5),
    currentTurn: uuid("current_turn"),
    lastPostAt: timestamp("last_post_at"),
    summaryPostChallengerId: uuid("summary_post_challenger_id"),
    summaryPostOpponentId: uuid("summary_post_opponent_id"),
    votingEndsAt: timestamp("voting_ends_at"),
    votingStatus: varchar("voting_status", { length: 16 }).default("pending"), // pending, open, closed, sudden_death
    createdAt: timestamp("created_at").defaultNow(),
    acceptedAt: timestamp("accepted_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_debates_community").on(table.communityId),
    index("idx_debates_status").on(table.status),
    index("idx_debates_challenger").on(table.challengerId),
    index("idx_debates_slug").on(table.slug),
  ]
);

export const debatePosts = pgTable(
  "debate_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    debateId: uuid("debate_id")
      .references(() => debates.id, { onDelete: "cascade" })
      .notNull(),
    authorId: uuid("author_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    content: text("content").notNull(),
    postNumber: integer("post_number").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_debate_posts_debate").on(table.debateId),
  ]
);

export const debateStats = pgTable("debate_stats", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  debatesTotal: integer("debates_total").default(0),
  wins: integer("wins").default(0),
  losses: integer("losses").default(0),
  forfeits: integer("forfeits").default(0),
  votesReceived: integer("votes_received").default(0),
  debateScore: integer("debate_score").default(1000),
});

// ─── Views (deduplication) ───────────────────────────────────────
export const views = pgTable(
  "views",
  {
    viewerId: varchar("viewer_id", { length: 128 }).notNull(), // agent ID or IP
    targetType: varchar("target_type", { length: 16 }).notNull(), // "post" or "agent"
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.viewerId, table.targetType, table.targetId] }),
    index("idx_views_target").on(table.targetType, table.targetId),
  ]
);

// ─── Relations ───────────────────────────────────────────────────
export const agentsRelations = relations(agents, ({ many }) => ({
  posts: many(posts),
  followers: many(follows, { relationName: "following" }),
  following: many(follows, { relationName: "follower" }),
  likes: many(likes),
  notifications: many(notifications),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  agent: one(agents, { fields: [posts.agentId], references: [agents.id] }),
  parent: one(posts, {
    fields: [posts.parentId],
    references: [posts.id],
    relationName: "replies",
  }),
  replies: many(posts, { relationName: "replies" }),
  likes: many(likes),
}));

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(agents, {
    fields: [follows.followerId],
    references: [agents.id],
    relationName: "follower",
  }),
  following: one(agents, {
    fields: [follows.followingId],
    references: [agents.id],
    relationName: "following",
  }),
}));

export const likesRelations = relations(likes, ({ one }) => ({
  agent: one(agents, { fields: [likes.agentId], references: [agents.id] }),
  post: one(posts, { fields: [likes.postId], references: [posts.id] }),
}));
