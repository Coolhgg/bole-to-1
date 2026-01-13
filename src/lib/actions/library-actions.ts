'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { UUIDSchema, StatusSchema, ChapterSchema, RatingSchema } from '@/lib/schemas/actions'

export async function addToLibrary(seriesId: string, status: string = 'reading') {
  const seriesIdResult = UUIDSchema.safeParse(seriesId)
  if (!seriesIdResult.success) {
    return { error: 'Invalid series ID format' }
  }
  
  const statusResult = StatusSchema.safeParse(status)
  if (!statusResult.success) {
    return { error: 'Invalid status. Must be one of: reading, completed, planning, dropped, paused' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('library_entries')
    .insert({
      user_id: user.id,
      series_id: seriesIdResult.data,
      status: statusResult.data,
      last_read_chapter: 0,
      notify_new_chapters: true,
      sync_priority: 'WARM',
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return { error: 'Series already in library' }
    }
    return { error: error.message }
  }

    await supabase.from('activities').insert({
      user_id: user.id,
      type: 'series_added',
      series_id: seriesIdResult.data,
      metadata: { status: statusResult.data }
    })

    // KENMEI PARITY: Update activity score (user_follow: +3)
    try {
      const { promoteSeriesTier } = await import('@/lib/catalog-tiers');
      await promoteSeriesTier(seriesIdResult.data, 'user_follow');
    } catch (e) {
      console.error('Failed to promote series tier after follow:', e);
    }


  revalidatePath('/library')
  revalidatePath('/discover')
  revalidatePath('/feed')
  return { data }
}

export async function removeFromLibrary(entryId: string) {
  const entryIdResult = UUIDSchema.safeParse(entryId)
  if (!entryIdResult.success) {
    return { error: 'Invalid entry ID format' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const entry = await tx.libraryEntry.findUnique({
        where: { id: entryIdResult.data, user_id: user.id },
        select: { series_id: true },
      })

      if (!entry) {
        throw new Error('Library entry not found')
      }

      await tx.libraryEntry.delete({
        where: { id: entryIdResult.data },
      })

      if (entry.series_id) {
        await tx.$executeRaw`
          UPDATE series 
          SET total_follows = GREATEST(0, total_follows - 1)
          WHERE id = ${entry.series_id}::uuid
        `
      }
    })

    revalidatePath('/library')
    revalidatePath('/feed')
    return { success: true }
  } catch (error: any) {
    return { error: error.message || 'Failed to remove from library' }
  }
}

export async function updateProgress(entryId: string, chapter: number, seriesId: string, sourceId?: string) {
  const entryIdResult = UUIDSchema.safeParse(entryId)
  if (!entryIdResult.success) {
    return { error: 'Invalid entry ID format' }
  }
  
  const seriesIdResult = UUIDSchema.safeParse(seriesId)
  if (!seriesIdResult.success) {
    return { error: 'Invalid series ID format' }
  }
  
  const chapterResult = ChapterSchema.safeParse(chapter)
  if (!chapterResult.success) {
    return { error: 'Invalid chapter number. Must be a number between 0 and 100000' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('library_entries')
    .update({
      last_read_chapter: chapterResult.data,
      last_read_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryIdResult.data)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    return { error: error.message }
  }

  try {
    await supabase
      .from('users')
      .update({
        last_read_at: new Date().toISOString(),
      })
      .eq('id', user.id)
  } catch (e) {
    console.error('Failed to update user last_read_at:', e)
  }

  try {
    await supabase.rpc('increment_xp', { user_id: user.id, amount: 10 })
  } catch (e) {
    console.error('Failed to increment XP:', e)
  }

  try {
    await supabase.from('activities').insert({
      user_id: user.id,
      type: 'chapter_read',
      series_id: seriesIdResult.data,
      metadata: { 
        chapter_number: chapterResult.data,
        source_id: sourceId 
      }
    })
  } catch (e) {
    console.error('Failed to log activity:', e)
  }

    try {
      // Find the logical chapter for this series and number
      // We prioritize chapters with no slug or matching the number exactly
      const { data: logicalChapter } = await supabase
        .from('logical_chapters')
        .select('id')
        .eq('series_id', seriesIdResult.data)
        .eq('chapter_number', chapterResult.data)
        .eq('deleted_at', null)
        .limit(1)
        .maybeSingle()

      if (logicalChapter) {
        await supabase.from('user_chapter_reads_v2').upsert({
          user_id: user.id,
          chapter_id: logicalChapter.id,
          source_used_id: sourceId,
          read_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id,chapter_id'
        })
        
        // Also update legacy UserChapterRead if possible
        // This maintains compatibility with systems still reading from the old table
        try {
          const { data: legacyChapter } = await supabase
            .from('chapters')
            .select('id')
            .eq('series_id', seriesIdResult.data)
            .eq('chapter_number', chapterResult.data)
            .limit(1)
            .maybeSingle()
            
          if (legacyChapter) {
            await supabase.from('user_chapter_reads').upsert({
              user_id: user.id,
              chapter_id: legacyChapter.id,
              read_at: new Date().toISOString(),
            }, {
              onConflict: 'user_id,chapter_id'
            })
          }
        } catch (legacyErr) {
          // Non-critical
        }
      }
    } catch (e) {
      console.error('Failed to record telemetry:', e)
    }

  revalidatePath('/library')
  revalidatePath('/feed')
  revalidatePath(`/series/${seriesIdResult.data}`)
  return { data, xp_gained: 10 }
}

export async function updateStatus(entryId: string, status: string, seriesId: string) {
  const entryIdResult = UUIDSchema.safeParse(entryId)
  if (!entryIdResult.success) {
    return { error: 'Invalid entry ID format' }
  }
  
  const seriesIdResult = UUIDSchema.safeParse(seriesId)
  if (!seriesIdResult.success) {
    return { error: 'Invalid series ID format' }
  }
  
  const statusResult = StatusSchema.safeParse(status)
  if (!statusResult.success) {
    return { error: 'Invalid status. Must be one of: reading, completed, planning, dropped, paused' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('library_entries')
    .update({
      status: statusResult.data,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryIdResult.data)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    return { error: error.message }
  }

  if (statusResult.data === 'completed') {
    await supabase.rpc('increment_xp', { user_id: user.id, amount: 100 })
    
    await supabase.from('activities').insert({
      user_id: user.id,
      type: 'series_completed',
      series_id: seriesIdResult.data
    })
  }

  revalidatePath('/library')
  revalidatePath('/feed')
  revalidatePath(`/series/${seriesIdResult.data}`)
  return { data }
}

export async function updateRating(entryId: string, rating: number) {
  const entryIdResult = UUIDSchema.safeParse(entryId)
  if (!entryIdResult.success) {
    return { error: 'Invalid entry ID format' }
  }
  
  const ratingResult = RatingSchema.safeParse(rating)
  if (!ratingResult.success) {
    return { error: 'Invalid rating. Must be an integer between 1 and 10' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('library_entries')
    .update({
      user_rating: ratingResult.data,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryIdResult.data)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    return { error: error.message }
  }

  revalidatePath('/library')
  return { data }
}

export async function updatePreferredSource(entryId: string, sourceName: string) {
  const entryIdResult = UUIDSchema.safeParse(entryId)
  if (!entryIdResult.success) {
    return { error: 'Invalid entry ID format' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('library_entries')
    .update({
      preferred_source: sourceName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryIdResult.data)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    return { error: error.message }
  }

  revalidatePath('/library')
  return { data }
}

export async function updateGlobalDefaultSource(sourceName: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { error: 'Not authenticated' }
  }

  const { error } = await supabase
    .from('users')
    .update({
      default_source: sourceName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id)

  if (error) {
    return { error: error.message }
  }

  revalidatePath('/settings')
  return { success: true }
}
