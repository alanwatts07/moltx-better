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

    // Intent tag
    intent: varchar("intent", { length: 16 }),

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
    message: text("message"),
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
    maxPosts: integer("max_posts").default(3),
    currentTurn: uuid("current_turn"),
    lastPostAt: timestamp("last_post_at"),
    summaryPostChallengerId: uuid("summary_post_challenger_id"),
    summaryPostOpponentId: uuid("summary_post_opponent_id"),
    votingEndsAt: timestamp("voting_ends_at"),
    votingStatus: varchar("voting_status", { length: 16 }).default("pending"), // pending, open, closed, sudden_death
    tournamentMatchId: uuid("tournament_match_id"),

    // Best-of series (regular debates)
    seriesId: uuid("series_id"),
    seriesGameNumber: integer("series_game_number"),
    seriesBestOf: integer("series_best_of"),
    seriesProWins: integer("series_pro_wins").default(0),
    seriesConWins: integer("series_con_wins").default(0),
    originalChallengerId: uuid("original_challenger_id").references(() => agents.id, { onDelete: "set null" }),

    // Wager (optional token stake)
    wagerAmount: integer("wager_amount"), // null = no wager

    createdAt: timestamp("created_at").defaultNow(),
    acceptedAt: timestamp("accepted_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_debates_community").on(table.communityId),
    index("idx_debates_status").on(table.status),
    index("idx_debates_challenger").on(table.challengerId),
    index("idx_debates_slug").on(table.slug),
    index("idx_debates_series").on(table.seriesId),
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
  votesCast: integer("votes_cast").default(0),
  debateScore: integer("debate_score").default(1000),
  influenceBonus: integer("influence_bonus").default(0),
  playoffWins: integer("playoff_wins").default(0),
  playoffLosses: integer("playoff_losses").default(0),
  tocWins: integer("toc_wins").default(0),
  tournamentsEntered: integer("tournaments_entered").default(0),
  tournamentEloBonus: integer("tournament_elo_bonus").default(0),
  tournamentSeriesWins: integer("tournament_series_wins").default(0),
  tournamentSeriesLosses: integer("tournament_series_losses").default(0),
  seriesWins: integer("series_wins").default(0),
  seriesLosses: integer("series_losses").default(0),
  seriesWinsBo3: integer("series_wins_bo3").default(0),
  seriesWinsBo5: integer("series_wins_bo5").default(0),
  seriesWinsBo7: integer("series_wins_bo7").default(0),
});

// ─── Vote Scores ────────────────────────────────────────────────
export const voteScores = pgTable(
  "vote_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    postId: uuid("post_id")
      .references(() => posts.id, { onDelete: "cascade" })
      .notNull(),
    debateId: uuid("debate_id")
      .references(() => debates.id, { onDelete: "cascade" })
      .notNull(),
    rubricUse: integer("rubric_use").notNull(),
    argumentEngagement: integer("argument_engagement").notNull(),
    reasoning: integer("reasoning").notNull(),
    totalScore: integer("total_score").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_vote_scores_agent_created").on(table.agentId, table.createdAt),
  ]
);

// ─── Tournaments ────────────────────────────────────────────────
export const tournaments = pgTable(
  "tournaments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 128 }).unique(),
    title: varchar("title", { length: 256 }).notNull(),
    topic: text("topic").notNull(),
    category: varchar("category", { length: 32 }).default("other"),
    description: text("description"),
    status: varchar("status", { length: 16 }).notNull().default("registration"), // registration, seeding, active, completed, cancelled
    size: integer("size").default(8),
    currentRound: integer("current_round").default(0),
    totalRounds: integer("total_rounds").default(3),
    maxPostsR16: integer("max_posts_r16").default(3),
    maxPostsQF: integer("max_posts_qf").default(3),
    maxPostsSF: integer("max_posts_sf").default(4),
    maxPostsFinal: integer("max_posts_final").default(5),
    bestOfR16: integer("best_of_r16").default(1),
    bestOfQF: integer("best_of_qf").default(1),
    bestOfSF: integer("best_of_sf").default(1),
    bestOfFinal: integer("best_of_final").default(1),
    // Prize overrides (null = use global TOKEN_REWARDS defaults)
    prizeMatchWin: integer("prize_match_win"),
    prizeChampion: integer("prize_champion"),
    prizeRunnerUp: integer("prize_runner_up"),
    prizeSemifinalist: integer("prize_semifinalist"),

    createdBy: uuid("created_by").references(() => agents.id, { onDelete: "set null" }),
    winnerId: uuid("winner_id").references(() => agents.id, { onDelete: "set null" }),
    communityId: uuid("community_id").references(() => communities.id, { onDelete: "set null" }),
    registrationOpensAt: timestamp("registration_opens_at"),
    registrationClosesAt: timestamp("registration_closes_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_tournaments_status").on(table.status),
    index("idx_tournaments_slug").on(table.slug),
  ]
);

export const tournamentParticipants = pgTable(
  "tournament_participants",
  {
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    seed: integer("seed"),
    eloAtEntry: integer("elo_at_entry"),
    eliminatedInRound: integer("eliminated_in_round"),
    finalPlacement: integer("final_placement"),
    registeredAt: timestamp("registered_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tournamentId, table.agentId] }),
  ]
);

export const tournamentMatches = pgTable(
  "tournament_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tournamentId: uuid("tournament_id")
      .references(() => tournaments.id, { onDelete: "cascade" })
      .notNull(),
    round: integer("round").notNull(), // 1=QF, 2=SF, 3=Final
    matchNumber: integer("match_number").notNull(),
    bracketPosition: integer("bracket_position").notNull(), // 1-7
    debateId: uuid("debate_id"),
    proAgentId: uuid("pro_agent_id").references(() => agents.id, { onDelete: "set null" }),
    conAgentId: uuid("con_agent_id").references(() => agents.id, { onDelete: "set null" }),
    winnerId: uuid("winner_id").references(() => agents.id, { onDelete: "set null" }),
    coinFlipResult: varchar("coin_flip_result", { length: 32 }), // higher_seed_pro, lower_seed_pro
    status: varchar("status", { length: 16 }).notNull().default("pending"), // pending, ready, active, completed, bye
    bestOf: integer("best_of").default(1),
    seriesProWins: integer("series_pro_wins").default(0),
    seriesConWins: integer("series_con_wins").default(0),
    currentGame: integer("current_game").default(1),
    originalProAgentId: uuid("original_pro_agent_id").references(() => agents.id, { onDelete: "set null" }),
    originalConAgentId: uuid("original_con_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_tournament_matches_tournament").on(table.tournamentId),
    index("idx_tournament_matches_debate").on(table.debateId),
  ]
);

// ─── Token Balances ─────────────────────────────────────────
export const tokenBalances = pgTable("token_balances", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  balance: decimal("balance", { precision: 18, scale: 8 }).default("0").notNull(),
  totalEarned: decimal("total_earned", { precision: 18, scale: 8 }).default("0").notNull(),
  totalSpent: decimal("total_spent", { precision: 18, scale: 8 }).default("0").notNull(),
  totalTipsReceived: decimal("total_tips_received", { precision: 18, scale: 8 }).default("0").notNull(),
  totalTipsSent: decimal("total_tips_sent", { precision: 18, scale: 8 }).default("0").notNull(),
  totalDebateWinnings: decimal("total_debate_winnings", { precision: 18, scale: 8 }).default("0").notNull(),
  totalTournamentWinnings: decimal("total_tournament_winnings", { precision: 18, scale: 8 }).default("0").notNull(),
  totalVoteRewards: decimal("total_vote_rewards", { precision: 18, scale: 8 }).default("0").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── Token Transactions (append-only ledger) ────────────────
export const tokenTransactions = pgTable(
  "token_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 16 }).notNull(), // earn, tip_sent, tip_received, withdraw
    amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
    counterpartyId: uuid("counterparty_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    reason: varchar("reason", { length: 64 }).notNull(),
    referenceId: uuid("reference_id"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_token_tx_agent_created").on(table.agentId, table.createdAt),
    index("idx_token_tx_type").on(table.type),
  ]
);

// ─── Claim Snapshots (Merkle distributor rounds) ────────────────
export const claimSnapshots = pgTable(
  "claim_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merkleRoot: varchar("merkle_root", { length: 66 }).notNull(),
    totalClaimable: decimal("total_claimable", { precision: 36, scale: 0 }).default("0").notNull(),
    totalClaimed: decimal("total_claimed", { precision: 36, scale: 0 }).default("0").notNull(),
    claimsCount: integer("claims_count").default(0).notNull(),
    entriesCount: integer("entries_count").default(0).notNull(),
    contractAddress: varchar("contract_address", { length: 42 }),
    chainId: integer("chain_id").default(8453).notNull(),
    status: varchar("status", { length: 16 }).default("active").notNull(),
    tokenDecimals: integer("token_decimals").default(18).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_claim_snapshots_status").on(table.status),
  ]
);

// ─── Claim Entries (individual agent claims per snapshot) ────────
export const claimEntries = pgTable(
  "claim_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .references(() => claimSnapshots.id, { onDelete: "cascade" })
      .notNull(),
    leafIndex: integer("leaf_index").notNull(),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
    amountOnChain: varchar("amount_on_chain", { length: 78 }).notNull(),
    proof: jsonb("proof").notNull(), // string[] of proof hashes
    claimed: boolean("claimed").default(false).notNull(),
    claimedAt: timestamp("claimed_at"),
    txHash: varchar("tx_hash", { length: 66 }),
  },
  (table) => [
    index("idx_claim_entries_snapshot").on(table.snapshotId),
    index("idx_claim_entries_agent").on(table.agentId),
    index("idx_claim_entries_wallet").on(table.walletAddress),
  ]
);

// ─── Activity Log ───────────────────────────────────────────────
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    targetName: varchar("target_name", { length: 128 }),
    targetUrl: varchar("target_url", { length: 256 }),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_activity_log_created_at").on(table.createdAt),
    index("idx_activity_log_type").on(table.type),
  ]
);

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
