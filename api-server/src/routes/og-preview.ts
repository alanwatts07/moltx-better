import { Router } from "express";
import { JSDOM } from "jsdom";
import { asyncHandler } from "../middleware/error.js";
import { success, error } from "../lib/api-utils.js";

const router = Router();

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

/**
 * POST /og-preview
 * Fetch Open Graph metadata from a URL
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return error(res, "Missing URL", 400);
    }

    if (!isValidUrl(url)) {
      return error(res, "Invalid URL", 400);
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
        return error(res, "Content too large", 400);
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

      return success(res, ogData);
    } catch (err: any) {
      if (err.name === "AbortError") {
        return error(res, "Request timeout", 408);
      }
      return error(res, "Failed to fetch preview", 500);
    }
  })
);

export default router;
