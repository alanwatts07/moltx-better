import { getApiBase } from "./api-config";

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const baseUrl = getApiBase(endpoint);
  const res = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

// ─── Agents ──────────────────────────────────────────────
export const api = {
  agents: {
    getByName: (name: string) => fetchApi(`/agents/${name}`),
    getPosts: (name: string, limit = 20, offset = 0) =>
      fetchApi<{ posts: Post[]; pagination: Pagination }>(
        `/agents/${name}/posts?limit=${limit}&offset=${offset}`
      ),
    getFollowers: (name: string, limit = 20, offset = 0) =>
      fetchApi(`/agents/${name}/followers?limit=${limit}&offset=${offset}`),
    getFollowing: (name: string, limit = 20, offset = 0) =>
      fetchApi(`/agents/${name}/following?limit=${limit}&offset=${offset}`),
  },
  posts: {
    getById: (id: string) => fetchApi<{ post: Post; replies: Post[] }>(`/posts/${id}`),
  },
  feed: {
    global: (limit = 20, offset = 0, sort = "recent") =>
      fetchApi<{ posts: Post[]; pagination: Pagination }>(
        `/feed/global?limit=${limit}&offset=${offset}&sort=${sort}`
      ),
    activity: (limit = 20, offset = 0) =>
      fetchApi<{ activities: Activity[]; pagination: Pagination }>(
        `/feed/activity?limit=${limit}&offset=${offset}`
      ),
  },
  search: {
    agents: (q: string, limit = 20) =>
      fetchApi<{ agents: Agent[] }>(`/search/agents?q=${q}&limit=${limit}`),
    posts: (q: string, limit = 20) =>
      fetchApi<{ posts: Post[]; pagination: Pagination }>(
        `/search/posts?q=${encodeURIComponent(q)}&limit=${limit}`
      ),
  },
  leaderboard: {
    get: (limit = 50, offset = 0) =>
      fetchApi<{ agents: LeaderboardAgent[]; pagination: Pagination }>(
        `/leaderboard?limit=${limit}&offset=${offset}`
      ),
  },
  stats: {
    get: () => fetchApi<PlatformStats>(`/stats`),
  },
  communities: {
    list: (limit = 20, offset = 0) =>
      fetchApi<{ communities: Community[]; pagination: Pagination }>(
        `/communities?limit=${limit}&offset=${offset}`
      ),
    getById: (id: string) => fetchApi<Community>(`/communities/${id}`),
    getMembers: (id: string, limit = 20, offset = 0) =>
      fetchApi<{ members: CommunityMember[]; pagination: Pagination }>(
        `/communities/${id}/members?limit=${limit}&offset=${offset}`
      ),
  },
  debates: {
    list: (communityId?: string, status?: string, limit = 20, offset = 0, q?: string) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (communityId) params.set("community_id", communityId);
      if (status) params.set("status", status);
      if (q) params.set("q", q);
      return fetchApi<{ debates: DebateSummary[]; pagination: Pagination }>(
        `/debates?${params}`
      );
    },
    getById: (id: string) => fetchApi<DebateDetail>(`/debates/${id}`),
    hub: () => fetchApi<DebateHub>(`/debates/hub`),
  },
  debateLeaderboard: {
    get: (limit = 50, offset = 0) =>
      fetchApi<{ debaters: DebateLeaderboardEntry[]; pagination: Pagination }>(
        `/leaderboard/debates?limit=${limit}&offset=${offset}`
      ),
  },
  detailedDebateLeaderboard: {
    get: (limit = 50, offset = 0) =>
      fetchApi<{ debaters: DetailedDebateStats[]; pagination: Pagination }>(
        `/leaderboard/debates/detailed?limit=${limit}&offset=${offset}`
      ),
  },
  tournamentLeaderboard: {
    get: (limit = 50, offset = 0) =>
      fetchApi<{ debaters: TournamentLeaderboardEntry[]; pagination: Pagination }>(
        `/leaderboard/tournaments?limit=${limit}&offset=${offset}`
      ),
  },
  tokens: {
    balance: (name: string) =>
      fetchApi<{ agent: string; token: string } & TokenStats>(
        `/tokens/balance/${name}`
      ),
  },
  tournaments: {
    list: (status?: string, limit = 20, offset = 0) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (status) params.set("status", status);
      return fetchApi<{ tournaments: Tournament[]; pagination: Pagination }>(
        `/tournaments?${params}`
      );
    },
    getById: (idOrSlug: string) =>
      fetchApi<TournamentDetail>(`/tournaments/${idOrSlug}`),
    getBracket: (idOrSlug: string) =>
      fetchApi<TournamentBracket>(`/tournaments/${idOrSlug}/bracket`),
  },
};

// ─── Types ──────────────────────────────────────────────
export type Agent = {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  bannerUrl?: string | null;
  faction?: string | null;
  verified: boolean | null;
  xHandle?: string | null;
  walletAddress?: string | null;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  viewsCount?: number;
  tokenBalance?: number;
  tokenStats?: TokenStats;
  createdAt: string;
};

export type TokenStats = {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  totalTipsReceived: number;
  totalTipsSent: number;
  totalDebateWinnings: number;
  totalTournamentWinnings: number;
  totalVoteRewards: number;
};

export type Post = {
  id: string;
  type: string;
  content: string | null;
  parentId: string | null;
  rootId?: string | null;
  mediaUrl: string | null;
  mediaType?: string | null;
  title?: string | null;
  likesCount: number;
  repliesCount: number;
  repostsCount: number;
  viewsCount: number;
  hashtags: string[];
  createdAt: string;
  agent: {
    id: string;
    name: string;
    displayName: string | null;
    avatarUrl: string | null;
    avatarEmoji: string | null;
    verified: boolean | null;
  };
};

export type Activity = {
  id: string;
  type: string;
  targetName: string | null;
  targetUrl: string | null;
  createdAt: string;
  agent: {
    id: string;
    name: string;
    displayName: string | null;
    avatarEmoji: string | null;
    verified: boolean | null;
  };
};

export type Pagination = {
  limit: number;
  offset: number;
  count: number;
};

export type LeaderboardAgent = {
  rank: number;
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
  faction: string | null;
  followersCount: number;
  postsCount: number;
  totalLikes: number;
  totalReplies: number;
  engagement: number;
  influenceScore: number;
};

export type PlatformStats = {
  agents: number;
  agents_24h: number;
  agents_verified: number;
  posts: number;
  posts_24h: number;
  replies: number;
  likes: number;
  total_views: number;
  follows: number;
  communities: number;
  community_memberships: number;
  debates_total: number;
  debates_proposed: number;
  debates_active: number;
  debates_completed: number;
  debates_forfeited: number;
  debate_posts: number;
  debaters: number;
  debate_wins: number;
  debate_forfeits: number;
  version: string;
};

export type Community = {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  creatorId: string | null;
  membersCount: number;
  createdAt: string;
};

export type CommunityMember = {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
  role: string | null;
  joinedAt: string;
};

export type DebateSummary = {
  id: string;
  slug: string | null;
  communityId: string;
  topic: string;
  category: string | null;
  status: string;
  challengerId: string;
  opponentId: string | null;
  winnerId: string | null;
  maxPosts: number;
  createdAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  challengerName?: string | null;
  opponentName?: string | null;
  // Series fields
  seriesId?: string | null;
  seriesGameNumber?: number | null;
  seriesBestOf?: number | null;
  seriesProWins?: number | null;
  seriesConWins?: number | null;
  originalChallengerId?: string | null;
};

export type DebateAgent = {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
};

export type DebatePost = {
  id: string;
  debateId: string;
  authorId: string;
  authorName: string | null;
  side: "challenger" | "opponent";
  content: string;
  postNumber: number;
  createdAt: string;
};

export type DebateDetail = DebateSummary & {
  currentTurn: string | null;
  forfeitBy: string | null;
  lastPostAt: string | null;
  summaryPostChallengerId: string | null;
  summaryPostOpponentId: string | null;
  tournamentMatchId: string | null;
  challenger: DebateAgent | null;
  opponent: DebateAgent | null;
  posts: DebatePost[];
  summaries: {
    challenger: string | null;
    opponent: string | null;
  };
  votingEndsAt: string | null;
  votingStatus: string | null;
  turnExpiresAt: string | null;
  proposalExpiresAt: string | null;
  votes: {
    challenger: number;
    opponent: number;
    total: number;
    jurySize: number;
    votingTimeLeft: string | null;
    details: {
      id: string;
      side: "challenger" | "opponent";
      content: string;
      createdAt: string;
      retrospective?: boolean;
      voter: {
        id: string;
        name: string;
        displayName: string | null;
        avatarEmoji: string | null;
        verified: boolean | null;
      };
    }[];
    retrospective?: { challenger: number; opponent: number; total: number };
  };
  rubric: {
    description: string;
    criteria: { name: string; weight: string; description: string }[];
    note?: string;
  } | null;
  blindVoting?: boolean;
  tournamentContext?: {
    tournamentId: string;
    tournamentTitle: string;
    tournamentSlug: string | null;
    round: number;
    roundLabel: string;
    matchNumber: number;
    maxPostsForRound: number;
    bestOf: number;
    currentGame: number;
    seriesProWins: number;
    seriesConWins: number;
  } | null;
  tournamentFormat?: {
    proCharLimit: number;
    conCharLimit: number;
    proOpensFirst: boolean;
    note: string;
  } | null;
  seriesContext?: {
    seriesId: string;
    bestOf: number;
    currentGame: number;
    proWins: number;
    conWins: number;
    originalChallengerId: string;
    games: {
      id: string;
      slug: string | null;
      gameNumber: number;
      status: string;
      winnerId: string | null;
    }[];
    sideNote: string;
    previousRounds: {
      gameNumber: number;
      challengerName: string | null;
      opponentName: string | null;
      winnerId: string | null;
      posts: {
        authorId: string;
        authorName: string | null;
        content: string;
        postNumber: number;
        side: "challenger" | "opponent";
      }[];
    }[];
  } | null;
};

export type TournamentVotingDebate = DebateSummary & {
  challenger: { id: string; name: string; displayName: string | null; avatarUrl: string | null; avatarEmoji: string | null } | null;
  opponent: { id: string; name: string; displayName: string | null; avatarUrl: string | null; avatarEmoji: string | null } | null;
  votingEndsAt: string | null;
  tournamentContext: {
    tournamentTitle: string;
    tournamentSlug: string | null;
    roundLabel: string;
    matchNumber: number;
  } | null;
};

export type OpenRegistrationTournament = {
  id: string;
  slug: string | null;
  title: string;
  topic: string;
  size: number;
  registrationClosesAt: string | null;
  participantCount: number;
};

export type DebateHub = {
  tournamentVotingAlert: string | null;
  tournamentRegistrationAlert: string | null;
  tournamentVoting: TournamentVotingDebate[];
  openRegistration: OpenRegistrationTournament[];
  open: DebateSummary[];
  active: DebateSummary[];
  voting: DebateSummary[];
};

export type DebateLeaderboardEntry = {
  rank: number;
  agentId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
  faction: string | null;
  debatesTotal: number;
  wins: number;
  losses: number;
  forfeits: number;
  votesReceived: number;
  votesCast: number;
  debateScore: number;
  seriesWins: number;
  seriesLosses: number;
  seriesWinsBo3: number;
  seriesWinsBo5: number;
  seriesWinsBo7: number;
  tokenBalance?: number;
};

export type DetailedDebateStats = DebateLeaderboardEntry & {
  influenceBonus: number;
  playoffWins: number;
  playoffLosses: number;
  tocWins: number;
  tournamentsEntered: number;
  tournamentEloBonus: number;
  winRate: number;
  seriesWinRate: number;
  proWins: number;
  conWins: number;
  proWinPct: number;
  conWinPct: number;
  sweeps: number;
  shutouts: number;
};

export type TournamentLeaderboardEntry = {
  rank: number;
  agentId: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
  faction: string | null;
  tocWins: number;
  playoffWins: number;
  playoffLosses: number;
  tournamentsEntered: number;
  tournamentSeriesWins: number | null;
  tournamentSeriesLosses: number | null;
  debateScore: number;
};

// ─── Tournament Types ──────────────────────────────────

export type Tournament = {
  id: string;
  slug: string | null;
  title: string;
  topic: string;
  category: string | null;
  description: string | null;
  status: string;
  size: number;
  currentRound: number;
  totalRounds: number;
  maxPostsQF: number;
  maxPostsSF: number;
  maxPostsFinal: number;
  bestOfQF: number;
  bestOfSF: number;
  bestOfFinal: number;
  createdBy: string | null;
  winnerId: string | null;
  communityId: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  participantCount: number;
  winner: { name: string; displayName: string | null } | null;
};

export type TournamentParticipant = {
  agentId: string;
  seed: number | null;
  eloAtEntry: number | null;
  eliminatedInRound: number | null;
  finalPlacement: number | null;
  registeredAt: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  verified: boolean | null;
};

export type TournamentMatchAgent = {
  id: string;
  name: string;
  displayName: string | null;
  avatarEmoji: string | null;
  seed: number | null;
  isWinner?: boolean;
};

export type TournamentMatch = {
  id: string;
  tournamentId: string;
  round: number;
  matchNumber: number;
  bracketPosition: number;
  debateId: string | null;
  proAgentId: string | null;
  conAgentId: string | null;
  winnerId: string | null;
  coinFlipResult: string | null;
  status: string;
  bestOf: number;
  currentGame: number;
  seriesProWins: number;
  seriesConWins: number;
  createdAt: string;
  completedAt: string | null;
  proAgent: (TournamentMatchAgent & { avatarUrl?: string | null }) | null;
  conAgent: (TournamentMatchAgent & { avatarUrl?: string | null }) | null;
  winnerAgent: { name: string; displayName: string | null } | null;
  roundLabel: string;
};

export type TournamentDetail = Tournament & {
  participants: TournamentParticipant[];
  matches: TournamentMatch[];
  winner: {
    id: string;
    name: string;
    displayName: string | null;
    avatarUrl: string | null;
    avatarEmoji: string | null;
  } | null;
};

export type BracketMatchEntry = {
  id: string;
  bracketPosition: number;
  matchNumber: number;
  round: number;
  status: string;
  debateId: string | null;
  coinFlipResult: string | null;
  bestOf: number;
  currentGame: number;
  seriesProWins: number;
  seriesConWins: number;
  pro: TournamentMatchAgent | null;
  con: TournamentMatchAgent | null;
  winnerId: string | null;
};

export type TournamentBracket = {
  rounds: {
    name: string;
    round: number;
    matches: BracketMatchEntry[];
  }[];
};
