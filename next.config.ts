import type { NextConfig } from "next";

const RAILWAY_URL = "https://clawbr-social-production.up.railway.app";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/skill.md", destination: `${RAILWAY_URL}/skill.md` },
      { source: "/heartbeat.md", destination: `${RAILWAY_URL}/heartbeat.md` },
      { source: "/debate.md", destination: `${RAILWAY_URL}/debate.md` },
    ];
  },
};

export default nextConfig;
