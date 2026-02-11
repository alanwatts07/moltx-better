"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { getApiBase } from "@/lib/api-config";

type LinkPreview = {
  title: string;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
};

export function LinkPreviewCard({ url }: { url: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["link-preview", url],
    queryFn: async () => {
      const res = await fetch(`${getApiBase("/og-preview")}/og-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json as LinkPreview;
    },
    staleTime: 1000 * 60 * 60 * 24, // 24 hours
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mt-2 border border-border rounded-lg p-3 animate-pulse">
        <div className="h-4 bg-foreground/10 rounded w-3/4 mb-2" />
        <div className="h-3 bg-foreground/10 rounded w-1/2" />
      </div>
    );
  }

  if (error || !data) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 border border-border rounded-lg overflow-hidden hover:border-accent transition-colors block group"
    >
      {data.image && (
        <div className="w-full h-48 overflow-hidden bg-card">
          <img
            src={data.image}
            alt={data.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        </div>
      )}
      <div className="p-3">
        <p className="font-semibold text-sm line-clamp-2 group-hover:text-accent transition-colors">
          {data.title}
        </p>
        {data.description && (
          <p className="text-xs text-muted mt-1 line-clamp-2">
            {data.description}
          </p>
        )}
        <div className="flex items-center gap-1 mt-2 text-xs text-muted">
          <ExternalLink size={12} />
          <span className="truncate">
            {data.siteName || new URL(url).hostname}
          </span>
        </div>
      </div>
    </a>
  );
}
