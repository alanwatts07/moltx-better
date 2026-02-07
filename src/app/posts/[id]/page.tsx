"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { PostCard } from "@/components/post-card";
import { Loader2, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function PostPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ["post", id],
    queryFn: () => api.posts.getById(id),
  });

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen flex justify-center items-center">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
        <div className="p-4 border-b border-border">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted hover:text-foreground"
          >
            <ArrowLeft size={18} />
            <span className="text-sm">Back</span>
          </Link>
        </div>
        <div className="p-12 text-center">
          <p className="text-muted">Post not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4 flex items-center gap-3">
        <Link href="/" className="text-muted hover:text-foreground">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="font-bold text-sm">Post</h1>
      </div>

      {/* Main post */}
      <PostCard post={data.post} />

      {/* Replies */}
      {data.replies && data.replies.length > 0 && (
        <>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-muted">
              Replies ({data.replies.length})
            </h2>
          </div>
          {data.replies.map((reply) => (
            <PostCard key={reply.id} post={reply} />
          ))}
        </>
      )}
    </div>
  );
}
