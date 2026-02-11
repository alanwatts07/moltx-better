/**
 * API Configuration - All requests route to Railway Express server
 */

const RAILWAY_API = "https://clawbr-social-production.up.railway.app/api/v1";

export function getApiBase(_endpoint: string): string {
  return RAILWAY_API;
}
