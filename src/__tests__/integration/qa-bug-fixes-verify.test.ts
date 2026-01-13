/**
 * @jest-environment node
 */
import { prisma } from '@/lib/prisma'
import { GET as searchGET } from '@/app/api/series/search/route'
import { GET as chaptersGET } from '@/app/api/series/[id]/chapters/route'
import { NextRequest } from 'next/server'

describe('QA Bug Fixes Verification', () => {
  let testSeriesId: string

  beforeAll(async () => {
    // Setup test data
    let series = await prisma.series.findFirst({
      where: { title: 'QA Verification Manga' }
    })

    if (!series) {
      series = await prisma.series.create({
        data: {
          title: 'QA Verification Manga',
          type: 'manga',
          genres: ['Action'],
          catalog_tier: 'A',
          total_follows: 10
        }
      })
    } else {
      await prisma.series.update({
        where: { id: series.id },
        data: { deleted_at: null }
      })
    }
    testSeriesId = series.id
  })

  afterAll(async () => {
    // Cleanup
    await prisma.series.delete({ where: { id: testSeriesId } })
    await prisma.$disconnect()
  })

  it('Search API stability: returns results without crashing (formattedResults fix)', async () => {
    const url = 'http://localhost/api/series/search?q=Verification'
    const req = {
      url,
      nextUrl: new URL(url),
      headers: new Headers(),
    } as unknown as NextRequest
    
    const response = await searchGET(req)
    const data = await response.json()
    
    expect(response.status).toBe(200)
    expect(data.results).toBeDefined()
    expect(Array.isArray(data.results)).toBe(true)
    const found = data.results.some((s: any) => s.id === testSeriesId)
    expect(found).toBe(true)
  })

  it('Chapters API stability: non-grouped mode works (seriesId scope fix)', async () => {
    const url = `http://localhost/api/series/${testSeriesId}/chapters?grouped=false`
    const req = {
      url,
      nextUrl: new URL(url),
      headers: new Headers(),
    } as unknown as NextRequest
    
    const params = Promise.resolve({ id: testSeriesId })
    const response = await chaptersGET(req, { params })
    const data = await response.json()
    
    expect(response.status).toBe(200)
    expect(data.chapters).toBeDefined()
    expect(data.grouped).toBe(false)
  })

  it('Soft Delete: search should not return deleted series', async () => {
    await prisma.series.update({
      where: { id: testSeriesId },
      data: { deleted_at: new Date() }
    })

    const url = 'http://localhost/api/series/search?q=Verification'
    const req = {
      url,
      nextUrl: new URL(url),
      headers: new Headers(),
    } as unknown as NextRequest
    
    const response = await searchGET(req)
    const data = await response.json()
    
    const found = data.results.some((s: any) => s.id === testSeriesId)
    expect(found).toBe(false)

    await prisma.series.update({
      where: { id: testSeriesId },
      data: { deleted_at: null }
    })
  })
})
