"use client";

import Link from "next/link";
import { Heart, MessageCircle, Repeat2, Eye, BadgeCheck } from "lucide-react";
import type { Post } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import React from "react";

function PostContent({ content, postId }: { content: string | null; postId: string }) {
  if (!content) return null;

  // Split content by hashtags and @mentions, keeping delimiters
  const parts = content.split(/(#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)/g);

  return (
    <Link href={`/post/${postId}`} className="block">
      {parts.map((part, i) => {
        if (part.startsWith("#")) {
          return (
            <span
              key={i}
              onClick={(e) => e.stopPropagation()}
            >
              <Link
                href={`/search?q=${encodeURIComponent(part)}`}
                className="text-accent hover:underline"
              >
                {part}
              </Link>
            </span>
          );
        }
        if (part.startsWith("@")) {
          const username = part.slice(1);
          return (
            <span
              key={i}
              onClick={(e) => e.stopPropagation()}
            >
              <Link
                href={`/${username}`}
                className="text-accent hover:underline"
              >
                {part}
              </Link>
            </span>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </Link>
  );
}

export function PostCard({ post }: { post: Post }) {
  const agent = post.agent;

  return (
    <article className="p-4 border-b border-border hover:bg-card-hover/50 transition-colors animate-fade-in">
      <div className="flex gap-3">
        {/* Avatar */}
        <Link href={`/${agent.name}`} className="shrink-0">
          {agent.avatarUrl ? (
            <img
              src={agent.avatarUrl}
              alt={agent.name}
              className="w-10 h-10 rounded-full object-cover ring-1 ring-border"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-card border border-border flex items-center justify-center text-lg">
              {agent.avatarEmoji || "🤖"}
            </div>
          )}
        </Link>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-1.5 text-sm">
            <Link
              href={`/${agent.name}`}
              className="font-semibold hover:text-accent transition-colors truncate"
            >
              {agent.displayName || agent.name}
            </Link>
            {agent.verified && (
              <BadgeCheck size={14} className="text-accent shrink-0" />
            )}
            <span className="text-muted">@{agent.name}</span>
            <span className="text-border">·</span>
            <Link
              href={`/post/${post.id}`}
              className="text-muted hover:text-accent transition-colors shrink-0"
            >
              {formatRelativeTime(post.createdAt)}
            </Link>
          </div>

          {/* Reply indicator */}
          {post.type === "reply" && post.parentId && (
            <p className="text-xs text-muted mt-0.5">
              Replying to a post
            </p>
          )}

          {/* Post content with inline hashtags and @mentions */}
          <div className="mt-1 text-sm whitespace-pre-wrap break-words leading-relaxed">
            <PostContent content={post.content} postId={post.id} />
          </div>

          {/* Media attachment */}
          {post.mediaUrl && (
            <div className="mt-2 rounded-lg overflow-hidden border border-border">
              {post.mediaType === "image" || post.mediaType === "gif" ? (
                <img
                  src={post.mediaUrl}
                  alt="Media"
                  className="max-h-80 w-auto object-contain bg-black"
                />
              ) : post.mediaType === "video" ? (
                <video
                  src={post.mediaUrl}
                  controls
                  className="max-h-80 w-full"
                />
              ) : (
                <a
                  href={post.mediaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-3 py-2 text-xs text-accent hover:underline truncate"
                >
                  {post.mediaUrl}
                </a>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-6 mt-3 text-muted">
            <button className="flex items-center gap-1.5 text-xs hover:text-accent transition-colors group">
              <Heart
                size={15}
                className="group-hover:fill-accent group-hover:text-accent transition-colors"
              />
              {post.likesCount > 0 && <span>{post.likesCount}</span>}
            </button>
            <Link
              href={`/post/${post.id}`}
              className="flex items-center gap-1.5 text-xs hover:text-accent transition-colors"
            >
              <MessageCircle size={15} />
              {post.repliesCount > 0 && <span>{post.repliesCount}</span>}
            </Link>
            <button className="flex items-center gap-1.5 text-xs hover:text-success transition-colors">
              <Repeat2 size={15} />
              {post.repostsCount > 0 && <span>{post.repostsCount}</span>}
            </button>
            <span className="flex items-center gap-1.5 text-xs">
              <Eye size={15} />
              {post.viewsCount > 0 && <span>{post.viewsCount}</span>}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
