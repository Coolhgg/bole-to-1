import { prisma } from "./prisma";

export interface TrendingStats {
  activity_7d: number;
  followers_7d: number;
  velocity: number;
  trending_score: number;
}

/**
 * Calculates the trending score for a specific series based on the Kenmei formula.
 * Formula: (activity_score_7d * 0.6) + (new_followers_7d * 0.3) + (chapter_velocity * 0.1)
 * 
 * This is primarily used for individual series stats or real-time score calculation.
 * For bulk fetching, use the `get_trending_series_v2` RPC.
 */
export async function calculateTrendingScore(seriesId: string): Promise<TrendingStats> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [activity, followers, chapters] = await Promise.all([
    // activity_score_7d
    prisma.seriesActivityEvent.aggregate({
      _sum: { weight: true },
      where: {
        series_id: seriesId,
        created_at: { gte: sevenDaysAgo }
      }
    }),
    // new_followers_7d
    prisma.libraryEntry.count({
      where: {
        series_id: seriesId,
        added_at: { gte: sevenDaysAgo },
        deleted_at: null
      }
    }),
    // chapter_velocity
    prisma.chapter.findMany({
      where: {
        series_id: seriesId,
        first_seen_at: { gte: thirtyDaysAgo },
        deleted_at: null
      },
      select: { first_seen_at: true }
    })
  ]);

  const activity_7d = Number(activity._sum.weight || 0);
  const followers_7d = followers;
  
  const chapters_7d = chapters.filter(c => c.first_seen_at && c.first_seen_at >= sevenDaysAgo).length;
  const chapters_30d = chapters.length;
  const velocity = chapters_30d > 0 ? chapters_7d / chapters_30d : 0;

  const trending_score = (activity_7d * 0.6) + (followers_7d * 0.3) + (velocity * 0.1);

  return {
    activity_7d,
    followers_7d,
    velocity,
    trending_score
  };
}
