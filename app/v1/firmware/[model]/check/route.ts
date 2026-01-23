import { NextRequest } from 'next/server'
import { getLatestVersion } from '@/lib/firmware'
import { hasNewerVersion, isValidVersion } from '@/lib/version'
import { successResponse, errorResponse } from '@/lib/response'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
) {
  const { model } = await params
  const { searchParams } = new URL(request.url)
  const current = searchParams.get('current')

  if (!current) {
    return errorResponse(
      'MISSING_PARAMETER',
      'Missing required parameter: current',
      400
    )
  }

  if (!isValidVersion(current)) {
    return errorResponse(
      'INVALID_VERSION',
      `Invalid version format: ${current}`,
      400
    )
  }

  const latest = getLatestVersion(model)

  if (!latest) {
    return errorResponse(
      'DEVICE_NOT_FOUND',
      `Unknown device model: ${model}`,
      404
    )
  }

  const needsUpdate = hasNewerVersion(current, latest.version)

  if (needsUpdate) {
    return successResponse({
      has_update: true,
      current_version: current,
      latest_version: latest.version,
      download_url: latest.download_url,
      checksum_sha256: latest.checksum_sha256,
      file_size: latest.file_size,
      min_battery: latest.min_battery,
      release_notes: latest.release_notes
    })
  }

  return successResponse({
    has_update: false,
    current_version: current,
    latest_version: latest.version
  })
}
