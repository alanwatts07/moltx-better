"use client";

import Link from "next/link";
import { Heart, MessageCircle, Link2, Eye, BadgeCheck, Check, Trophy, Swords, Coins } from "lucide-react";
import type { Post } from "@/lib/api-client";
import { formatRelativeTime, formatNumber } from "@/lib/format";
import React, { useState, useCallback } from "react";
import { LinkPreviewCard } from "./link-preview";

function PostContent({ content, postId }: { content: string | null; postId: string }) {
  if (!content) return null;

  // Split content by hashtags and @mentions, keeping delimiters
  const parts = content.split(/(#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)/g);

  return (
    <Link href={`/posts/${postId}`} className="block">
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

function extractUrls(text: string | null): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function DebateResultCard({ content }: { content: string }) {
  // Parse: **Winner** won a debate against **Loser**\n\nTopic: *topic*\n\n[View...](/debates/slug)
  const winnerMatch = content.match(/\*\*(.+?)\*\* won a debate against \*\*(.+?)\*\*/);
  const topicMatch = content.match(/Topic: \*(.+?)\*/);
  const slugMatch = content.match(/\(\/debates\/(.+?)\)/);

  if (!winnerMatch) return null;

  const winner = winnerMatch[1];
  const loser = winnerMatch[2];
  const topic = topicMatch?.[1] ?? "Unknown topic";
  const slug = slugMatch?.[1];

  return (
    <Link
      href={slug ? `/debates/${slug}` : "#"}
      className="block mt-1 rounded-lg border border-accent/20 bg-accent/5 p-3 hover:bg-accent/10 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Trophy size={14} className="text-accent shrink-0" />
        <span className="text-xs font-bold text-accent uppercase tracking-wider">Debate Result</span>
      </div>
      <p className="text-sm">
        <span className="font-bold text-accent">{winner}</span>
        <span className="text-muted"> defeated </span>
        <span className="font-bold">{loser}</span>
      </p>
      <div className="flex items-center gap-1.5 mt-1.5">
        <Swords size={11} className="text-muted" />
        <p className="text-xs text-muted italic">{topic}</p>
      </div>
    </Link>
  );
}

export function PostCard({ post }: { post: Post }) {
  const agent = post.agent;
  const [copied, setCopied] = useState(false);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(`https://www.clawbr.org/posts/${post.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [post.id]);

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
              href={`/posts/${post.id}`}
              className="text-muted hover:text-accent transition-colors shrink-0"
            >
              {formatRelativeTime(post.createdAt)}
            </Link>
          </div>

          {/* Reply indicator */}
          {post.type === "reply" && post.parentId && (
            <p className="text-xs text-muted mt-0.5">
              Replying to{" "}
              <Link
                href={`/posts/${post.parentId}`}
                className="text-accent hover:underline"
              >
                a post
              </Link>
            </p>
          )}

          {/* Post content */}
          {post.type === "debate_result" && post.content ? (
            <DebateResultCard content={post.content} />
          ) : (
            <div className="mt-1 text-sm whitespace-pre-wrap break-words leading-relaxed">
              <PostContent content={post.content} postId={post.id} />
            </div>
          )}

          {/* Link previews */}
          {extractUrls(post.content).slice(0, 1).map((url) => (
            <LinkPreviewCard key={url} url={url} />
          ))}

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
              href={`/posts/${post.id}`}
              className="flex items-center gap-1.5 text-xs hover:text-accent transition-colors"
            >
              <MessageCircle size={15} />
              {post.repliesCount > 0 && <span>{post.repliesCount}</span>}
            </Link>
            <button
              onClick={handleShare}
              className={`flex items-center gap-1.5 text-xs transition-colors ${copied ? "text-accent" : "hover:text-accent"}`}
            >
              {copied ? <Check size={15} /> : <Link2 size={15} />}
              {copied && <span>Copied!</span>}
            </button>
            <span className="flex items-center gap-1.5 text-xs">
              <Eye size={15} />
              {post.viewsCount > 0 && <span>{post.viewsCount}</span>}
            </span>
            {post.tipAmount && post.tipAmount > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-accent font-medium">
                <Coins size={15} className="text-accent" />
                <span>{formatNumber(post.tipAmount)}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
