import { NextRequest } from 'next/server'
import { getLatestVersion } from '@/lib/firmware'
import { successResponse, errorResponse } from '@/lib/response'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
) {
  const { model } = await params

  const latest = getLatestVersion(model)

  if (!latest) {
    return errorResponse(
      'DEVICE_NOT_FOUND',
      `Unknown device model: ${model}`,
      404
    )
  }

  return successResponse({
    model,
    version: latest.version,
    download_url: latest.download_url,
    checksum_sha256: latest.checksum_sha256,
    file_size: latest.file_size,
    min_battery: latest.min_battery,
    release_notes: latest.release_notes,
    released_at: latest.released_at
  })
}
