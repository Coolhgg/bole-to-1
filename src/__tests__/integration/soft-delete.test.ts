import { prisma } from '@/lib/prisma'

describe('Soft Delete & Upsert Restoration (BUG 50 FIX)', () => {
  let testUserId: string

  beforeAll(async () => {
    // Cleanup any previous test data - using raw query to actually delete
    await prisma.$executeRaw`DELETE FROM users WHERE email LIKE '%@test-soft-delete.com'`
    
    // Create a test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@test-soft-delete.com`,
        username: `testuser_${Date.now()}`,
      }
    })
    testUserId = user.id
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: testUserId } })
    await prisma.$disconnect()
  })

  it('should soft delete a library entry', async () => {
    const entry = await prisma.libraryEntry.create({
      data: {
        user_id: testUserId,
        source_url: 'https://example.com/series/1',
        source_name: 'ExampleSource',
        status: 'reading'
      }
    })

    // Verify it exists
    const foundBefore = await prisma.libraryEntry.findUnique({ where: { id: entry.id } })
    expect(foundBefore).not.toBeNull()

    // Soft delete it
    await prisma.libraryEntry.delete({ where: { id: entry.id } })

    // Verify it is filtered out by normal queries
    const foundAfter = await prisma.libraryEntry.findUnique({ where: { id: entry.id } })
    expect(foundAfter).toBeNull()

    // Verify it still exists in the database with deleted_at set (using raw query)
    const rawResult: any[] = await prisma.$queryRaw`SELECT * FROM library_entries WHERE id = ${entry.id}::uuid`
    expect(rawResult[0].deleted_at).not.toBeNull()
  })

  it('should restore a soft-deleted record via upsert (BUG 50 FIX)', async () => {
    const sourceUrl = 'https://example.com/series/upsert-test'
    
    // 1. Create and then soft delete
    const entry = await prisma.libraryEntry.create({
      data: {
        user_id: testUserId,
        source_url: sourceUrl,
        source_name: 'ExampleSource',
        status: 'reading'
      }
    })
    await prisma.libraryEntry.delete({ where: { id: entry.id } })

    // 2. Perform upsert on the same unique key
    const upserted = await prisma.libraryEntry.upsert({
      where: { user_id_source_url: { user_id: testUserId, source_url: sourceUrl } },
      update: { status: 'plan_to_read' },
      create: {
        user_id: testUserId,
        source_url: sourceUrl,
        source_name: 'ExampleSource',
        status: 'reading'
      }
    })

    // 3. Verify it is restored (deleted_at is null) and updated
    expect(upserted.deleted_at).toBeNull()
    expect(upserted.status).toBe('plan_to_read')
    expect(upserted.id).toBe(entry.id) // Should be the same record

    const found = await prisma.libraryEntry.findUnique({ where: { id: entry.id } })
    expect(found).not.toBeNull()
    expect(found?.deleted_at).toBeNull()
  })
})
