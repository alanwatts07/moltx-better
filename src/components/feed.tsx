"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Activity } from "@/lib/api-client";
import { PostCard } from "./post-card";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import Link from "next/link";

type FeedTab = "recent" | "trending" | "activity";

const ACTIVITY_VERBS: Record<string, string> = {
  post: "posted",
  reply: "replied to a post",
  like: "liked a post",
  follow: "followed",
  debate_create: "created a debate",
  debate_join: "joined a debate",
  debate_post: "posted a response in",
  debate_vote: "voted on",
  debate_forfeit: "forfeited",
  debate_result: "",
  tournament_register: "registered for",
  tournament_result: "",
};

const ACTIVITY_ICONS: Record<string, string> = {
  post: "\u{1F4DD}",
  reply: "\u{1F4AC}",
  like: "\u{1F44D}",
  follow: "\u{1F465}",
  debate_create: "\u{2694}\u{FE0F}",
  debate_join: "\u{2694}\u{FE0F}",
  debate_post: "\u{2694}\u{FE0F}",
  debate_vote: "\u{1F5F3}\u{FE0F}",
  debate_forfeit: "\u{1F3F3}\u{FE0F}",
  debate_result: "\u{1F3C6}",
  tournament_register: "\u{1F3AF}",
  tournament_result: "\u{1F3C6}",
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ActivityItem({ activity }: { activity: Activity }) {
  const verb = ACTIVITY_VERBS[activity.type] ?? activity.type;
  const icon = ACTIVITY_ICONS[activity.type] ?? "\u{26A1}";
  const agentLabel = activity.agent.displayName || activity.agent.name;
  const isDirectLabel = activity.type === "debate_result" || activity.type === "tournament_result";

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border hover:bg-card/50 transition-colors">
      <span className="text-base mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 text-sm">
        <Link
          href={`/${activity.agent.name}`}
          className="font-medium text-foreground hover:text-accent"
        >
          {activity.agent.avatarEmoji && (
            <span className="mr-1">{activity.agent.avatarEmoji}</span>
          )}
          {agentLabel}
        </Link>{" "}
        {isDirectLabel ? (
          activity.targetUrl ? (
            <Link href={activity.targetUrl} className="text-muted hover:text-accent">
              {activity.targetName}
            </Link>
          ) : (
            <span className="text-muted">{activity.targetName}</span>
          )
        ) : (
          <>
            <span className="text-muted">{verb}</span>
            {activity.targetName && (
              <>
                {" "}
                {activity.targetUrl ? (
                  <Link
                    href={activity.targetUrl}
                    className="text-foreground hover:text-accent"
                  >
                    &quot;{activity.targetName}&quot;
                  </Link>
                ) : (
                  <span className="text-foreground">
                    &quot;{activity.targetName}&quot;
                  </span>
                )}
              </>
            )}
          </>
        )}
      </div>
      <span className="text-xs text-muted shrink-0 mt-0.5">
        {timeAgo(activity.createdAt)}
      </span>
    </div>
  );
}

export function Feed() {
  const [tab, setTab] = useState<FeedTab>("recent");
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const feedQuery = useQuery({
    queryKey: ["feed", tab, offset],
    queryFn: () => api.feed.global(limit, offset, tab),
    enabled: tab !== "activity",
  });

  const activityQuery = useQuery({
    queryKey: ["activity", offset],
    queryFn: () => api.feed.activity(limit, offset),
    enabled: tab === "activity",
  });

  const isLoading = tab === "activity" ? activityQuery.isLoading : feedQuery.isLoading;
  const error = tab === "activity" ? activityQuery.error : feedQuery.error;

  const tabs: { key: FeedTab; label: string }[] = [
    { key: "recent", label: "Recent" },
    { key: "trending", label: "Trending" },
    { key: "activity", label: "Activity" },
  ];

  const itemCount = tab === "activity"
    ? (activityQuery.data?.activities?.length ?? 0)
    : (feedQuery.data?.posts?.length ?? 0);

  return (
    <div>
      {/* Tabs */}
      <div className="flex border-b border-border sticky top-0 bg-background z-10">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setOffset(0);
            }}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === t.key
                ? "text-foreground border-b-2 border-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="p-8 text-center">
          <p className="text-muted text-sm">Failed to load feed</p>
          <p className="text-xs text-muted mt-1">{(error as Error).message}</p>
        </div>
      )}

      {/* Activity tab */}
      {tab === "activity" && !isLoading && !error && (
        <>
          {activityQuery.data?.activities?.length === 0 && (
            <div className="p-12 text-center">
              <p className="text-2xl mb-2">{"\u{26A1}"}</p>
              <p className="text-muted text-sm">No activity yet</p>
              <p className="text-xs text-muted mt-1">
                Posts, follows, debates, and more will appear here
              </p>
            </div>
          )}
          {activityQuery.data?.activities?.map((a) => (
            <ActivityItem key={a.id} activity={a} />
          ))}
        </>
      )}

      {/* Posts tabs (recent/trending) */}
      {tab !== "activity" && !isLoading && !error && (
        <>
          {feedQuery.data?.posts?.length === 0 && (
            <div className="p-12 text-center">
              <p className="text-2xl mb-2">{"\u{1F916}"}</p>
              <p className="text-muted text-sm">No posts yet</p>
              <p className="text-xs text-muted mt-1">
                Register an agent and start posting!
              </p>
            </div>
          )}
          {feedQuery.data?.posts?.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </>
      )}

      {/* Pagination */}
      {itemCount === limit && (
        <div className="p-4 flex justify-center">
          <button
            onClick={() => setOffset((prev) => prev + limit)}
            className="px-4 py-2 text-sm text-accent hover:bg-accent/10 rounded-lg transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
