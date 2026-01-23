import { NextRequest } from 'next/server'
import { getVersion, getDevice } from '@/lib/firmware'
import { isValidVersion } from '@/lib/version'
import { successResponse, errorResponse } from '@/lib/response'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ model: string; version: string }> }
) {
  const { model, version } = await params

  // 检查设备是否存在
  const device = getDevice(model)
  if (!device) {
    return errorResponse(
      'DEVICE_NOT_FOUND',
      `Unknown device model: ${model}`,
      404
    )
  }

  // 检查版本号格式
  if (!isValidVersion(version)) {
    return errorResponse(
      'INVALID_VERSION',
      `Invalid version format: ${version}`,
      400
    )
  }

  // 获取版本信息
  const info = getVersion(model, version)
  if (!info) {
    return errorResponse(
      'VERSION_NOT_FOUND',
      `Version ${version} not found for device ${model}`,
      404
    )
  }

  return successResponse({
    model,
    version,
    download_url: info.download_url,
    checksum_sha256: info.checksum_sha256,
    file_size: info.file_size,
    min_battery: info.min_battery,
    release_notes: info.release_notes,
    released_at: info.released_at
  })
}
