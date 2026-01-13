import { prisma } from '@/lib/prisma'
import { POST } from '@/app/api/library/import/route'
import { NextRequest } from 'next/server'

// Mock createClient to return a test user
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(() => Promise.resolve({ data: { user: { id: '00000000-0000-0000-0000-000000000001' } } }))
    }
  }))
}))

// Mock logSecurityEvent to avoid side effects
jest.mock('@/lib/api-utils', () => ({
  checkRateLimit: jest.fn(() => Promise.resolve(true)),
  getClientIp: jest.fn(() => '127.0.0.1'),
  handleApiError: jest.fn((err) => {
    const status = err.statusCode || 500
    return { 
      status, 
      json: () => Promise.resolve({ error: err.message, code: err.code }) 
    }
  }),
  ErrorCodes: {
    BAD_REQUEST: 'BAD_REQUEST',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    RATE_LIMITED: 'RATE_LIMITED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    INVALID_INPUT: 'INVALID_INPUT',
  },
  ApiError: class extends Error {
    statusCode: number
    code: string
    constructor(message: string, statusCode: number, code: string) {
      super(message)
      this.statusCode = statusCode
      this.code = code
    }
  },
  logSecurityEvent: jest.fn(),
  validateOrigin: jest.fn(),
  validateContentType: jest.fn(),
  validateJsonSize: jest.fn(() => Promise.resolve()),
  validateUUID: jest.fn(),
}))

describe('Library Import API Integration', () => {
  const testUserId = '00000000-0000-0000-0000-000000000001'

  beforeAll(async () => {
    // Ensure test user exists in DB
    await prisma.$executeRaw`DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001'::uuid`
    await prisma.user.create({
      data: {
        id: testUserId,
        email: 'import-test@example.com',
        username: 'import_tester',
      }
    })
  })

  beforeEach(async () => {
    // Clear jobs and library entries for the test user
    await prisma.importJob.deleteMany({ where: { user_id: testUserId } })
    await prisma.libraryEntry.deleteMany({ where: { user_id: testUserId } })
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: testUserId } })
    await prisma.$disconnect()
  })

  it('should create an import job with unique items', async () => {
    const payload = {
      source: 'MangaDex',
      entries: [
        { title: 'Series 1', source_url: 'https://mangadex.org/title/1' },
        { title: 'Series 1', source_url: 'https://mangadex.org/title/1' }, // Duplicate
        { title: 'Series 2', source_url: 'https://mangadex.org/title/2' },
      ]
    }

    const req = new NextRequest('http://localhost/api/library/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.message).toContain('1 duplicates skipped')

    const job = await prisma.importJob.findUnique({
      where: { id: data.job_id },
      include: { items: true }
    })

    expect(job?.total_items).toBe(2)
    expect(job?.items).toHaveLength(2)
  })

  it('should skip items already in the user library', async () => {
    // 1. Pre-populate library
    await prisma.libraryEntry.create({
      data: {
        user_id: testUserId,
        source_url: 'https://mangadex.org/title/existing',
        source_name: 'MangaDex',
        status: 'reading'
      }
    })

    const payload = {
      source: 'MangaDex',
      entries: [
        { title: 'Existing Series', source_url: 'https://mangadex.org/title/existing' },
        { title: 'New Series', source_url: 'https://mangadex.org/title/new' },
      ]
    }

    const req = new NextRequest('http://localhost/api/library/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)

    const job = await prisma.importJob.findUnique({
      where: { id: data.job_id },
      include: { items: true }
    })

    // Should only have 1 item (the new one)
    expect(job?.total_items).toBe(1)
    expect(job?.items[0].title).toBe('New Series')
  })

  it('should return 200 with message if all items are duplicates', async () => {
    await prisma.libraryEntry.create({
      data: {
        user_id: testUserId,
        source_url: 'https://mangadex.org/title/existing',
        source_name: 'MangaDex',
        status: 'reading'
      }
    })

    const payload = {
      source: 'MangaDex',
      entries: [
        { title: 'Existing Series', source_url: 'https://mangadex.org/title/existing' },
      ]
    }

    const req = new NextRequest('http://localhost/api/library/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.message).toContain('already in your library')
    
    // Should NOT have created a job
    const jobCount = await prisma.importJob.count({ where: { user_id: testUserId } })
    expect(jobCount).toBe(0)
  })
})
