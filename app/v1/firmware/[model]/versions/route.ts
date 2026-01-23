import { NextRequest } from 'next/server'
import { getAllVersions } from '@/lib/firmware'
import { successResponse, errorResponse } from '@/lib/response'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
) {
  const { model } = await params

  const versions = getAllVersions(model)

  if (!versions) {
    return errorResponse(
      'DEVICE_NOT_FOUND',
      `Unknown device model: ${model}`,
      404
    )
  }

  return successResponse({
    model,
    latest: versions.latest,
    versions: versions.versions
  })
}
