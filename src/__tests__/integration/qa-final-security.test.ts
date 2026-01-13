/**
 * @jest-environment node
 */
import { prisma } from '@/lib/prisma';
import { PATCH as updateProgress } from '@/app/api/library/[id]/progress/route';
import { PATCH as updateEntry, DELETE as deleteEntry } from '@/app/api/library/[id]/route';
import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

describe('QA Final Verification: Security & Auth Overlap', () => {
  let userA: any;
  let userB: any;
  let entryA: any;

  beforeAll(async () => {
    userA = await prisma.user.create({
      data: {
        email: `usera-${Date.now()}@test.com`,
        username: `usera_${Math.random().toString(36).slice(2, 7)}`,
        password_hash: 'test',
      }
    });

    userB = await prisma.user.create({
      data: {
        email: `userb-${Date.now()}@test.com`,
        username: `userb_${Math.random().toString(36).slice(2, 7)}`,
        password_hash: 'test',
      }
    });

    entryA = await prisma.libraryEntry.create({
      data: {
        user_id: userA.id,
        source_url: 'https://example.com/manga/1',
        source_name: 'test',
        status: 'reading',
        imported_title: 'Manga A',
      }
    });
  });

  afterAll(async () => {
    await prisma.libraryEntry.deleteMany({ where: { user_id: { in: [userA.id, userB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  test('User B should NOT be able to update User A\'s library entry progress', async () => {
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: userB } }),
      },
    };
    (createClient as jest.Mock).mockResolvedValue(mockSupabase);

    const req = new NextRequest(`http://localhost/api/library/${entryA.id}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({ chapterNumber: 10, isRead: true }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await updateProgress(req, { params: Promise.resolve({ id: entryA.id }) });
    expect(response.status).toBe(404); // Should return 404 Not Found (since it's filtered by user_id)
    
    // Verify entry wasn't updated
    const freshEntry = await prisma.libraryEntry.findUnique({ where: { id: entryA.id } });
    expect(Number(freshEntry?.last_read_chapter || 0)).toBe(0);
  });

  test('User B should NOT be able to delete User A\'s library entry', async () => {
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: userB } }),
      },
    };
    (createClient as jest.Mock).mockResolvedValue(mockSupabase);

    const req = new NextRequest(`http://localhost/api/library/${entryA.id}`, {
      method: 'DELETE',
    });

    const response = await deleteEntry(req, { params: Promise.resolve({ id: entryA.id }) });
    expect(response.status).toBe(404);
    
    // Verify entry still exists
    const freshEntry = await prisma.libraryEntry.findUnique({ where: { id: entryA.id } });
    expect(freshEntry).not.toBeNull();
  });

  test('User A SHOULD be able to update their own library entry', async () => {
    const mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: userA } }),
      },
    };
    (createClient as jest.Mock).mockResolvedValue(mockSupabase);

    const req = new NextRequest(`http://localhost/api/library/${entryA.id}/progress`, {
      method: 'PATCH',
      body: JSON.stringify({ chapterNumber: 5, isRead: true }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await updateProgress(req, { params: Promise.resolve({ id: entryA.id }) });
    expect(response.status).toBe(200);
    
    const freshEntry = await prisma.libraryEntry.findUnique({ where: { id: entryA.id } });
    expect(Number(freshEntry?.last_read_chapter)).toBe(5);
  });
});
