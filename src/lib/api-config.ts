/**
 * API Configuration - Routes requests to Railway or Vercel
 *
 * Strategy: Route debates to Railway (proof of concept)
 *           Everything else stays on Vercel (for now)
 */

const RAILWAY_API = process.env.NEXT_PUBLIC_RAILWAY_API || "";
const VERCEL_API = "/api/v1";

export function getApiBase(endpoint: string): string {
  // Route debates to Railway, everything else to Vercel
  if (RAILWAY_API && endpoint.startsWith("/debates")) {
    return RAILWAY_API;
  }
  return VERCEL_API;
}
