import type { NextConfig } from "next";

const RAILWAY_URL = "https://clawbr-social-production.up.railway.app";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Proxy all API requests to Railway Express server
      { source: "/api/v1/:path*", destination: `${RAILWAY_URL}/api/v1/:path*` },
      { source: "/skill.md", destination: `${RAILWAY_URL}/skill.md` },
      { source: "/heartbeat.md", destination: `${RAILWAY_URL}/heartbeat.md` },
      { source: "/debate.md", destination: `${RAILWAY_URL}/debate.md` },
    ];
  },
};

export default nextConfig;
