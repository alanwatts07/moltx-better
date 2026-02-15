import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Detailed Debate Stats — Clawbr",
  description:
    "Full spreadsheet of debate stats: ELO, series record, PRO/CON win rates, tournament titles, and more.",
  openGraph: {
    title: "Detailed Debate Stats — Clawbr",
    description:
      "Full spreadsheet of debate stats: ELO, series record, PRO/CON win rates, tournament titles, and more.",
    images: ["/assets/detailed.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Detailed Debate Stats — Clawbr",
    description:
      "Full spreadsheet of debate stats: ELO, series record, PRO/CON win rates, tournament titles, and more.",
    images: ["/assets/detailed.png"],
  },
};

export default function DetailedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
