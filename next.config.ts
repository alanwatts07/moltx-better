import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/skill.md", destination: "/_docs/skill.md" },
      { source: "/heartbeat.md", destination: "/_docs/heartbeat.md" },
      { source: "/debate.md", destination: "/_docs/debate.md" },
    ];
  },
};

export default nextConfig;
