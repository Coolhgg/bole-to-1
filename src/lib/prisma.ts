import { PrismaClient } from '@prisma/client'
import { logger } from './logger'

// Models that support soft delete
const SOFT_DELETE_MODELS = ['User', 'Series', 'Chapter', 'LibraryEntry']

// Global singleton storage for Prisma clients
const globalForPrisma = global as unknown as { 
  prisma: any
  prismaRead: any
}

/**
 * Configure Prisma with robust connection handling and Soft Delete extension
 */
const prismaClientSingleton = (url?: string) => {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['error', 'warn'] 
      : ['error'],
    datasources: url ? { db: { url } } : undefined
  })

  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (SOFT_DELETE_MODELS.includes(model)) {
            // 1. Intercept Read Operations
            if (
              operation === 'findUnique' || 
              operation === 'findUniqueOrThrow' ||
              operation === 'findFirst' || 
              operation === 'findFirstOrThrow' ||
              operation === 'findMany' ||
              operation === 'count' ||
              operation === 'aggregate' ||
              operation === 'groupBy'
            ) {
              args.where = { ...args.where, deleted_at: null }
            }

            // 2. Intercept Delete Operations -> Convert to Soft Delete
            if (operation === 'delete') {
              return (client as any)[model].update({
                ...args,
                data: { deleted_at: new Date() }
              })
            }

            if (operation === 'deleteMany') {
              return (client as any)[model].updateMany({
                ...args,
                data: { deleted_at: new Date() }
              })
            }

            // 3. Intercept Update Operations
            if (operation === 'update' || operation === 'updateMany') {
              if (args.where) {
                // Prevent updating records that are already soft-deleted
                args.where = { ...args.where, deleted_at: null }
              }
            }

            // 4. SPECIAL CASE: Upsert (BUG 50 FIX)
            // We DON'T filter by deleted_at: null in the 'where' clause of upsert.
            // This allows upsert to find a soft-deleted record and update it.
            // However, we MUST ensure the update operation clears the deleted_at flag.
            if (operation === 'upsert') {
              args.update = { ...args.update, deleted_at: null }
            }
          }
          return query(args)
        },
      },
    },
  })
}

// Primary write client (always uses DATABASE_URL)
export const prisma = globalForPrisma.prisma ?? prismaClientSingleton()

// Read replica client (falls back to primary if not configured)
export const prismaRead = globalForPrisma.prismaRead ?? (
  process.env.DATABASE_READ_URL 
    ? prismaClientSingleton(process.env.DATABASE_READ_URL) 
    : prisma
)

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaRead = prismaRead === prisma ? null : prismaRead
}

/**
 * Check if a Prisma error is transient (connection-related)
 */
export function isTransientError(error: any): boolean {
  if (!error) return false
  
  const errorMessage = (error.message || '').toLowerCase()
  const errorCode = error.code || ''
  const errorName = error.name || error.constructor?.name || ''
  
  // SECURITY FIX: Check non-transient errors FIRST
  const nonTransientPatterns = [
    'password authentication failed',
    'authentication failed',
    'invalid password',
    'access denied',
    'permission denied',
    'role .* does not exist',
    'database .* does not exist',
    'invalid credentials',
  ]

  for (const pattern of nonTransientPatterns) {
    if (pattern.includes('.*')) {
      if (new RegExp(pattern, 'i').test(errorMessage)) return false
    } else if (errorMessage.includes(pattern)) {
      return false
    }
  }

  const nonTransientCodes = ['P1000', 'P1003']
  if (nonTransientCodes.includes(errorCode)) return false

  const transientPatterns = [
    'circuit breaker',
    "can't reach database",
    'connection refused',
    'connection reset',
    'connection timed out',
    'econnrefused',
    'econnreset',
    'etimedout',
    'unable to establish connection',
    'connection pool timeout',
    'too many connections',
    'tenant or user not found',
    'pool_timeout',
    'server closed the connection unexpectedly',
    'prepared statement',
    'ssl connection has been closed unexpectedly',
  ]
  
  const transientCodes = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', '40001', '40P01', '57P01']
  
  const isInitError = 
    errorName.includes('PrismaClientInitializationError') ||
    errorName.includes('PrismaClientKnownRequestError') ||
    (errorMessage.includes('prisma') && (errorMessage.includes('initialization') || errorMessage.includes('invocation')))
  
  const patternMatch = transientPatterns.some(pattern => errorMessage.includes(pattern))
  const codeMatch = transientCodes.includes(errorCode)
  
  return isInitError || patternMatch || codeMatch
}

/**
 * Wrapper for Prisma queries with retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 200
): Promise<T> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error: any) {
      lastError = error
      if (!isTransientError(error) || attempt === maxRetries - 1) throw error
      
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError!
}

/**
 * Safe query wrapper
 */
export async function safeQuery<T>(
  operation: () => Promise<T>,
  fallback?: T
): Promise<{ data: T | null; error: Error | null }> {
  try {
    const data = await withRetry(operation)
    return { data, error: null }
  } catch (error: any) {
    logger.error('Database query error', { error: error.message?.slice(0, 200) })
    return { data: fallback ?? null, error }
  }
}

const handleShutdown = async () => {
  if (prisma && prisma.$disconnect) await prisma.$disconnect()
  if (prismaRead && prismaRead.$disconnect) await prismaRead.$disconnect()
}

if (typeof process !== 'undefined' && process.on) {
  process.on('beforeExit', handleShutdown)
  process.on('SIGINT', handleShutdown)
  process.on('SIGTERM', handleShutdown)
}
