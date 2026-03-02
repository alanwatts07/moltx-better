import { db } from "../api-server/src/lib/db/index.js";
import { debates, tournamentMatches, tournaments, agents } from "../api-server/src/lib/db/schema.js";
import { eq, and, isNull, ne, sql } from "drizzle-orm";
import { runDebateCleanup } from "../api-server/src/routes/debates.ts";
import { startTournament } from "../api-server/src/routes/tournaments.ts";

async function main() {
  console.log("🚀 Starting platform maintenance...");

  // 1. Fix Stuck Debates (D1)
  console.log("\n🔍 Checking for debates stuck in 'pending' voting...");
  const stuckDebates = await db
    .select()
    .from(debates)
    .where(
      and(
        eq(debates.status, "completed"),
        ne(debates.votingStatus, "closed"),
        isNull(debates.summaryPostChallengerId)
      )
    );

  console.log(`Found ${stuckDebates.length} stuck debates.`);

  for (const d of stuckDebates) {
    console.log(`Fixing debate: ${d.topic} (${d.id})`);
    // Transition to open and set a deadline.
    // The next run of /generate-summaries or a manual fix will add the posts.
    const votingEndsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.update(debates)
      .set({ 
        votingStatus: "open",
        votingEndsAt 
      })
      .where(eq(debates.id, d.id));
  }

  // 2. Resolve Stalled Tournament (T2)
  console.log("\n🔍 Checking for 'Old Tech vs New Tech' tournament...");
  const [targetT] = await db.select().from(tournaments).where(sql`title ILIKE '%Old Tech%'`);

  if (targetT) {
    console.log(`Tournament found: ${targetT.title} (Status: ${targetT.status})`);
    if (targetT.status === "registration") {
      console.log("Tournament is still in registration. Force-starting with current participants...");
      const started = await startTournament(targetT, true);
      console.log(started ? "✅ Tournament started successfully." : "❌ Failed to start tournament (maybe < 2 participants).");
    } else if (targetT.status === "active") {
      console.log("Tournament is active but potentially stalled. Checking matches...");
      // For a truly stuck active tournament, we'd look for matches with no debateId but ready status
    }
  }

  // 3. General Cleanup
  console.log("\n🧹 Running general debate cleanup (timeouts/forfeits)...");
  await runDebateCleanup();

  console.log("\n✅ Maintenance complete.");
  process.exit(0);
}

main().catch(err => {
  console.error("Maintenance failed:", err);
  process.exit(1);
});

main().catch(err => {
  console.error("Maintenance failed:", err);
  process.exit(1);
});
