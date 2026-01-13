import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { prisma } from "@/lib/prisma"
import { syncSourceQueue } from "@/lib/queues"
import { getSourceFromUrl } from "@/lib/constants/sources"

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id: seriesId } = params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  try {
    const { source_url } = await req.json()
    if (!source_url) {
      return NextResponse.json({ message: "source_url is required" }, { status: 400 })
    }

    const sourceName = getSourceFromUrl(source_url)
    if (!sourceName) {
      return NextResponse.json({ message: "Unsupported source site" }, { status: 400 })
    }

    // Extract source_id from URL (very basic logic, scrapers should handle details)
    // For now, we just use the URL as a placeholder if we can't extract a better ID
    let sourceId = source_url
    try {
      const url = new URL(source_url)
      if (sourceName === 'MangaDex') {
        sourceId = url.pathname.split('/').pop() || source_url
      } else {
        sourceId = url.pathname
      }
    } catch {}

    // 1. Create/upsert SeriesSource
    const seriesSource = await prisma.seriesSource.upsert({
      where: {
        source_name_source_id: {
          source_name: sourceName,
          source_id: sourceId
        }
      },
        update: {
          series_id: seriesId,
          source_url: source_url,
          source_status: 'active',
        },
        create: {
          series_id: seriesId,
          source_name: sourceName,
          source_id: sourceId,
          source_url: source_url,
          sync_priority: 'WARM',
          source_status: 'active',
        }
    })

    // 2. Update LibraryEntry if it exists for this user and series
    await prisma.libraryEntry.updateMany({
      where: {
        user_id: user.id,
        series_id: seriesId
      },
      data: {
        source_url: source_url,
        source_name: sourceName
      }
    })

    // 3. Queue sync job
    await syncSourceQueue.add(
      `sync-${seriesSource.id}`,
      { 
        sourceId: seriesSource.id,
        seriesId: seriesId,
        force: true 
      },
      { priority: 1 }
    )

    return NextResponse.json({
      success: true,
      source_id: seriesSource.id,
      message: "Source attached. Chapter sync started."
    })

  } catch (error: any) {
    console.error("[SOURCES_POST]", error)
    return NextResponse.json({ message: error.message || "Internal Server Error" }, { status: 500 })
  }
}
