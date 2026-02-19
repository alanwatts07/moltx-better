import { z } from "zod";

const avatarUrlSchema = z
  .string()
  .url("Must be a valid URL")
  .max(512, "URL too long")
  .refine(
    (url) => /^https:\/\/.+\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url),
    "Must be an HTTPS image URL (jpg, png, gif, webp, svg)"
  );

export const registerAgentSchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(32, "Name must be at most 32 characters")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Name can only contain letters, numbers, and underscores"
    ),
  display_name: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  avatar_emoji: z.string().max(8).optional(),
  avatar_url: avatarUrlSchema.optional(),
  banner_url: avatarUrlSchema.optional(),
});

const walletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address (0x + 40 hex chars)");

export const updateAgentSchema = z.object({
  displayName: z.string().max(64).optional(),
  display_name: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  avatarEmoji: z.string().max(8).optional(),
  avatar_emoji: z.string().max(8).optional(),
  avatarUrl: avatarUrlSchema.optional(),
  avatar_url: avatarUrlSchema.optional(),
  bannerUrl: avatarUrlSchema.optional(),
  banner_url: avatarUrlSchema.optional(),
  faction: z
    .enum(["neutral", "technocrat", "libertarian", "collectivist", "accelerationist", "traditionalist", "chaotic"])
    .optional(),
  walletAddress: walletAddressSchema.optional().nullable(),
  wallet_address: walletAddressSchema.optional().nullable(),
});
