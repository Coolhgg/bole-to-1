"use server"

import { prisma } from './prisma';
import { UserSourcePreferences } from './source-utils-shared';

export async function getUserSourcePreferences(
  userId: string,
  seriesId: string
): Promise<UserSourcePreferences> {
  const [seriesPreference, globalPriorities] = await Promise.all([
    prisma.userSeriesSourcePreference.findUnique({
      where: {
        user_id_series_id: {
          user_id: userId,
          series_id: seriesId,
        },
      },
    }),
    prisma.userSourcePriority.findMany({
      where: { user_id: userId },
      orderBy: { priority: 'asc' },
    }),
  ]);

  const globalPrioritiesMap = new Map<string, number>();
  globalPriorities.forEach((p) => globalPrioritiesMap.set(p.source_name, p.priority));

  return {
    seriesPreference,
    globalPriorities: globalPrioritiesMap,
  };
}
