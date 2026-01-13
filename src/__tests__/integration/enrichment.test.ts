import { prisma } from "@/lib/prisma"
import { processLibraryEntryResolution } from "@/workers/processors/resolution.processor"

/**
 * Integration test for the enrichment (resolution) pipeline.
 * Tests how library entries are linked to series and how duplicates are handled.
 */
describe('Enrichment Integration', () => {
  let testUser: any

  beforeAll(async () => {
    // Setup test user
    testUser = await prisma.user.create({
      data: {
        email: `test-enrich-${Date.now()}@example.com`,
        username: `testenrich${Date.now()}`,
        password_hash: 'hashed',
      }
    })
  })

  afterAll(async () => {
    // Cleanup
    if (testUser) {
      await prisma.user.delete({ where: { id: testUser.id } })
    }
  })

  it('should link a library entry to an existing series by title', async () => {
    // 1. Create a series
    const series = await prisma.series.create({
      data: {
        title: 'Test Enrichment Series',
        type: 'manga',
        status: 'ongoing',
      }
    })

    // 2. Create a library entry for that series
    const entry = await prisma.libraryEntry.create({
      data: {
        user_id: testUser.id,
        source_url: 'https://example.com/manga/test-enrichment',
        source_name: 'test',
        imported_title: 'Test Enrichment Series',
        metadata_status: 'pending'
      }
    })

    // 3. Run resolution
    // We mock the external search part if necessary, but here we expect title matching
    await processLibraryEntryResolution(entry.id)

    // 4. Verify linking
    const updatedEntry = await prisma.libraryEntry.findUnique({
      where: { id: entry.id }
    })

    expect(updatedEntry?.series_id).toBe(series.id)
    expect(updatedEntry?.metadata_status).toBe('enriched')

    // Cleanup series
    await prisma.series.delete({ where: { id: series.id } })
  })

  it('should handle duplicate library entries for the same series gracefully', async () => {
    // 1. Create a series
    const series = await prisma.series.create({
      data: {
        title: 'Duplicate Test Series',
        type: 'manga',
      }
    })

    // 2. Create two entries that resolve to the same series
    const entry1 = await prisma.libraryEntry.create({
      data: {
        user_id: testUser.id,
        source_url: 'https://mangadex.org/title/dup-1',
        source_name: 'mangadex',
        imported_title: 'Duplicate Test Series',
      }
    })

    const entry2 = await prisma.libraryEntry.create({
      data: {
        user_id: testUser.id,
        source_url: 'https://other.com/dup-2',
        source_name: 'other',
        imported_title: 'Duplicate Test Series',
      }
    })

    // 3. Process both
    await Promise.all([
      processLibraryEntryResolution(entry1.id),
      processLibraryEntryResolution(entry2.id)
    ])

    // 4. Verify they both link to the same series
    const [up1, up2] = await Promise.all([
      prisma.libraryEntry.findUnique({ where: { id: entry1.id } }),
      prisma.libraryEntry.findUnique({ where: { id: entry2.id } })
    ])

    expect(up1?.series_id).toBe(series.id)
    expect(up2?.series_id).toBe(series.id)

    // Cleanup
    await prisma.series.delete({ where: { id: series.id } })
  })
})
