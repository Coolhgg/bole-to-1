import { prisma } from '@/lib/prisma';
import { runTierDemotionCheck, refreshActivityScore } from '@/lib/catalog-tiers';

/**
 * Periodically check for stale series and demote their tiers.
 * Also refreshes popularity ranks and activity scores for Tier A series.
 */
export async function runTierMaintenanceScheduler() {
  console.log('[TierMaintenance] Starting maintenance run...');
  
  try {
    // 1. Run demotion logic (Decay is applied here)
    await runTierDemotionCheck();
    
    // 2. Refresh activity scores for Tier A series that haven't been updated in 24h
    // This ensures popular series stay accurate even if no new activity happens
    const staleTierA = await prisma.series.findMany({
      where: {
        catalog_tier: 'A',
        updated_at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      },
      select: { id: true },
      take: 100
    });
    
    console.log(`[TierMaintenance] Refreshing activity scores for ${staleTierA.length} Tier A series`);
    
    for (const series of staleTierA) {
      await refreshActivityScore(series.id);
    }
    
    console.log('[TierMaintenance] Maintenance run complete.');
  } catch (error) {
    console.error('[TierMaintenance] Maintenance run failed:', error);
  }
}
