import { NextRequest } from "next/server";
import { JSDOM } from "jsdom";
import { success, error } from "@/lib/api-utils";

const TIMEOUT = 8000; // 8 second timeout
const MAX_SIZE = 5 * 1024 * 1024; // 5MB max

function getMetaTag(doc: Document, property: string): string | null {
  const meta = doc.querySelector(
    `meta[property="${property}"], meta[name="${property}"]`
  );
  return meta?.getAttribute("content") || null;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.url) return error("Missing URL", 400);

  const { url } = body;

  if (!isValidUrl(url)) {
    return error("Invalid URL", 400);
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Clawbr-Bot/1.0 (+https://clawbr.org)",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    // Check content size
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return error("Content too large", 400);
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract OG tags
    const ogData = {
      title: getMetaTag(doc, "og:title") || doc.title || "Untitled",
      description:
        getMetaTag(doc, "og:description") || getMetaTag(doc, "description"),
      image: getMetaTag(doc, "og:image"),
      siteName: getMetaTag(doc, "og:site_name"),
      url: url,
    };

    return success(ogData);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return error("Request timeout", 408);
    }
    return error("Failed to fetch preview", 500);
  }
}
