import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Start seeding...')

  // 1. Create Achievements (Safe Upsert)
  // Achievement definitions are essential for the gamification system
  const achievements = [
    {
      code: 'first_chapter',
      name: 'First Steps',
      description: 'Read your first chapter',
      xp_reward: 50,
      rarity: 'common',
      criteria: { type: 'chapter_count', threshold: 1 }
    },
    {
      code: 'speed_reader',
      name: 'Speed Reader',
      description: 'Read 100 chapters',
      xp_reward: 200,
      rarity: 'rare',
      criteria: { type: 'chapter_count', threshold: 100 }
    },
    {
      code: 'completionist',
      name: 'Completionist',
      description: 'Complete your first series',
      xp_reward: 500,
      rarity: 'epic',
      criteria: { type: 'completed_count', threshold: 1 }
    },
    {
      code: 'social_butterfly',
      name: 'Social Butterfly',
      description: 'Follow 10 other readers',
      xp_reward: 100,
      rarity: 'common',
      criteria: { type: 'follow_count', threshold: 10 }
    },
    {
      code: 'collector',
      name: 'The Collector',
      description: 'Add 50 series to your library',
      xp_reward: 300,
      rarity: 'rare',
      criteria: { type: 'library_count', threshold: 50 }
    }
  ]

  for (const ach of achievements) {
    await prisma.achievement.upsert({
      where: { code: ach.code },
      update: ach,
      create: ach,
    })
  }
  console.log('✅ Achievement definitions updated.')

  // REMOVED: Destructive deleteMany calls
  // REMOVED: Sample Series, Sources, and Chapters seeding

  console.log('🏁 Seeding finished successfully (Safe Mode).')
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
