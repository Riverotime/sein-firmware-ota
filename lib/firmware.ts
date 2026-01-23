import firmwareData from '@/data/firmware.json'

export interface FirmwareVersion {
  download_url: string
  checksum_sha256: string
  file_size: number
  min_battery: number
  release_notes: string
  released_at: string
}

export interface DeviceFirmware {
  latest: string
  versions: Record<string, FirmwareVersion>
}

type FirmwareData = Record<string, DeviceFirmware>

const data = firmwareData as FirmwareData

export function getDevice(model: string): DeviceFirmware | null {
  return data[model] || null
}

export function getLatestVersion(model: string): (FirmwareVersion & { version: string }) | null {
  const device = getDevice(model)
  if (!device) return null

  const version = device.latest
  const info = device.versions[version]
  if (!info) return null

  return { ...info, version }
}

export function getVersion(model: string, version: string): FirmwareVersion | null {
  const device = getDevice(model)
  if (!device) return null

  return device.versions[version] || null
}

export function getAllVersions(model: string) {
  const device = getDevice(model)
  if (!device) return null

  return {
    latest: device.latest,
    versions: Object.entries(device.versions)
      .map(([version, info]) => ({
        version,
        file_size: info.file_size,
        release_notes: info.release_notes,
        released_at: info.released_at
      }))
      .sort((a, b) => {
        // 按版本号降序排列
        const partsA = a.version.split('.').map(Number)
        const partsB = b.version.split('.').map(Number)
        for (let i = 0; i < 3; i++) {
          if (partsB[i] !== partsA[i]) return partsB[i] - partsA[i]
        }
        return 0
      })
  }
}
