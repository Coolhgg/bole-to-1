import { followUser, getActivityFeed } from '@/lib/social-utils';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

// Mock withRetry to just execute the callback
jest.mock('@/lib/prisma', () => {
  const actualPrisma = jest.requireActual('@/lib/prisma');
  return {
    ...actualPrisma,
    withRetry: jest.fn((cb) => cb()),
  };
});

describe('Social Lifecycle Integration', () => {
  const USER_A_ID = '00000000-0000-0000-0000-a00000000001';
  const USER_B_ID = '00000000-0000-0000-0000-b00000000001';
  const SERIES_ID = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    // Clear relevant tables
    await prisma.activity.deleteMany({});
    await prisma.follow.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.series.deleteMany({});

    // Create users
    await prisma.user.createMany({
      data: [
        {
          id: USER_A_ID,
          email: 'user-a@example.com',
          username: 'usera',
          privacy_settings: { activity_public: true },
        },
        {
          id: USER_B_ID,
          email: 'user-b@example.com',
          username: 'userb',
          privacy_settings: { activity_public: true },
        },
      ],
    });

    // Create series
    await prisma.series.create({
      data: {
        id: SERIES_ID,
        title: 'Test Series',
        type: 'manga',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should reflect a followed user\'s activity in the follower\'s feed', async () => {
    // 1. User A follows User B
    await followUser(USER_A_ID, 'userb');

    // Verify follow exists
    const follow = await prisma.follow.findUnique({
      where: {
        follower_id_following_id: {
          follower_id: USER_A_ID,
          following_id: USER_B_ID,
        },
      },
    });
    expect(follow).toBeDefined();

    // 2. User B performs an activity (reading a chapter)
    await prisma.activity.create({
      data: {
        user_id: USER_B_ID,
        type: 'chapter_read',
        series_id: SERIES_ID,
        metadata: { chapter_number: 1 },
      },
    });

    // 3. User A checks their "following" feed
    const feed = await getActivityFeed(USER_A_ID, { type: 'following' });

    // 4. Verify activity is in the feed
    expect(feed.items.length).toBeGreaterThan(0);
    const activity = feed.items[0];
    expect(activity.user.username).toBe('userb');
    expect(activity.type).toBe('chapter_read');
    expect(activity.series.title).toBe('Test Series');
  });

  it('should NOT show private activities in the feed', async () => {
    // User A follows User B
    await followUser(USER_A_ID, 'userb');

    // User B makes their activity private
    await prisma.user.update({
      where: { id: USER_B_ID },
      data: { privacy_settings: { activity_public: false } },
    });

    // User B performs an activity
    await prisma.activity.create({
      data: {
        user_id: USER_B_ID,
        type: 'chapter_read',
        series_id: SERIES_ID,
        metadata: { chapter_number: 2 },
      },
    });

    // User A checks their feed
    const feed = await getActivityFeed(USER_A_ID, { type: 'following' });

    // Verify activity is NOT in the feed due to privacy settings
    // Note: The getActivityFeed logic in social-utils.ts handles this via its WHERE clause
    expect(feed.items.length).toBe(0);
  });
});
