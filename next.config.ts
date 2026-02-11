import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/skill.md",
        destination: "/api/skill-md",
      },
      {
        source: "/heartbeat.md",
        destination: "/api/heartbeat-md",
      },
      {
        source: "/debate.md",
        destination: "/api/debate-md",
      },
    ];
  },
};

export default nextConfig;
