"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Plus, Check, Bookmark, Loader2, Globe, MoreHorizontal, Wrench } from "lucide-react"
import { updateProgress, addToLibrary } from "@/lib/actions/library-actions"
import { updateSeriesSourcePreference } from "@/lib/actions/series-actions"
import { SyncOutbox } from "@/lib/sync/outbox"
import { toast } from "sonner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AddReadingSourceDialog } from "./source-management/AddReadingSourceDialog"
import { FixMetadataDialog } from "./source-management/FixMetadataDialog"

export function SeriesActions({ 
  seriesId, 
  seriesTitle = "this series",
  libraryEntry,
  sources = [],
  seriesPreference = null
}: { 
  seriesId: string, 
  seriesTitle?: string,
  libraryEntry: any,
  sources?: any[],
  seriesPreference?: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [updatingSource, setUpdatingSource] = useState(false)
  const [showAddSource, setShowAddSource] = useState(false)
  const [showFixMetadata, setShowFixMetadata] = useState(false)

  const handleAdd = async () => {
    setLoading(true)
    try {
      if (!navigator.onLine) {
        SyncOutbox.enqueue('LIBRARY_ADD', { seriesId: seriesId, status: 'reading' });
        toast.success("Series queued to be added (Offline)");
        return;
      }
      const result = await addToLibrary(seriesId)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("Added to library")
      }
    } catch (error) {
      SyncOutbox.enqueue('LIBRARY_ADD', { seriesId: seriesId, status: 'reading' });
      toast.info("Connection lost. Series will be added when online.");
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/library/${libraryEntry.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Failed to remove from library')
      }

      toast.success("Removed from library")
      // Force a refresh of the page to update the UI
      window.location.reload()
    } catch (error: any) {
      toast.error(error.message || "Failed to remove from library")
    } finally {
      setLoading(false)
    }
  }

  const handleSourceChange = async (sourceName: string) => {
    setUpdatingSource(true)
    try {
      const result = await updateSeriesSourcePreference(seriesId, sourceName === "none" ? null : sourceName)
      
      if (result.success) {
        toast.success(`Preference updated to ${sourceName === "none" ? "Global Default" : sourceName}`)
      }
    } catch (error) {
      toast.error("Failed to update preferred source")
    } finally {
      setUpdatingSource(false)
    }
  }

  const preferredSource = seriesPreference || libraryEntry?.preferred_source || "none"

  return (
    <div className="flex items-center gap-2">
      {libraryEntry ? (
        <Button 
          variant="outline" 
          className="rounded-full px-6 border-zinc-200 dark:border-zinc-800"
          onClick={handleRemove}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Check className="size-4 mr-2 text-green-500" />}
          In Library
        </Button>
      ) : (
        <Button 
          className="bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 rounded-full px-8"
          onClick={handleAdd}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
          Add to Library
        </Button>
      )}

      {sources.length > 0 && (
        <div className="flex items-center">
          <Select 
            value={preferredSource} 
            onValueChange={handleSourceChange}
            disabled={updatingSource}
          >
            <SelectTrigger className="w-[160px] h-10 rounded-full border-zinc-200 dark:border-zinc-800 bg-transparent px-4">
              <Globe className="size-3.5 mr-2 text-zinc-500" />
              <SelectValue placeholder="Preferred Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Use Global Default</SelectItem>
              {sources.map(source => (
                <SelectItem key={source.id} value={source.source_name}>
                  {source.source_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!libraryEntry && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-full border-zinc-200 dark:border-zinc-800">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setShowAddSource(true)}>
              <Plus className="size-4 mr-2" />
              Add reading source
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setShowFixMetadata(true)}>
              <Wrench className="size-4 mr-2" />
              Fix metadata
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AddReadingSourceDialog 
        seriesId={seriesId}
        seriesTitle={seriesTitle}
        open={showAddSource}
        onOpenChange={setShowAddSource}
      />
      <FixMetadataDialog
        seriesId={seriesId}
        seriesTitle={seriesTitle}
        open={showFixMetadata}
        onOpenChange={setShowFixMetadata}
      />
    </div>
  )
}

