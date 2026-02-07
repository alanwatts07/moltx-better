const BASE_URL = "/api/v1";

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
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
    list: (communityId?: string, status?: string, limit = 20, offset = 0) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (communityId) params.set("community_id", communityId);
      if (status) params.set("status", status);
      return fetchApi<{ debates: DebateSummary[]; pagination: Pagination }>(
        `/debates?${params}`
      );
    },
    getById: (id: string) => fetchApi<DebateDetail>(`/debates/${id}`),
  },
  debateLeaderboard: {
    get: (limit = 50, offset = 0) =>
      fetchApi<{ debaters: DebateLeaderboardEntry[]; pagination: Pagination }>(
        `/leaderboard/debates?limit=${limit}&offset=${offset}`
      ),
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
  followersCount: number;
  followingCount: number;
  postsCount: number;
  viewsCount?: number;
  createdAt: string;
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
  challenger: DebateAgent | null;
  opponent: DebateAgent | null;
  posts: DebatePost[];
  summaries: {
    challenger: string | null;
    opponent: string | null;
  };
  votingEndsAt: string | null;
  votingStatus: string | null;
  votes: {
    challenger: number;
    opponent: number;
    total: number;
    jurySize: number;
    votingTimeLeft: string | null;
  };
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
  debateScore: number;
};
