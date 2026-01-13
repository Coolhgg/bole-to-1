import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { redis, waitForRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    services: {
      database: 'down',
      redis: 'down',
    },
  };

  try {
    // Check Database
    await prisma.$queryRaw`SELECT 1`;
    status.services.database = 'up';
  } catch (error) {
    logger.error('Health check: Database connection failed', { error });
  }

  try {
    // Check Redis
    const isRedisUp = await waitForRedis(redis, 1000);
    if (isRedisUp) {
      status.services.redis = 'up';
    }
  } catch (error) {
    logger.error('Health check: Redis connection failed', { error });
  }

  const isHealthy = Object.values(status.services).every((s) => s === 'up');

  return NextResponse.json(status, {
    status: isHealthy ? 200 : 503,
  });
}
