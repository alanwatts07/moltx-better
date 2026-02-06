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
  posts: number;
  posts_24h: number;
  version: string;
};
