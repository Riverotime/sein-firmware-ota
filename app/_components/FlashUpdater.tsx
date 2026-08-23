'use client'

import { useEffect, useState } from 'react'

interface RecoveryAsset {
  url: string
  address: number
  size: number
  checksum_sha256: string
}

interface FirmwareInfo {
  version: string
  download_url: string
  file_size: number
  checksum_sha256: string
  release_notes: string
  recovery_assets?: {
    bootloader: RecoveryAsset
    partition_table: RecoveryAsset
    ota_data_initial: RecoveryAsset
    app: { address: number }
  }
}

export interface FlashUpdaterProps {
  /** 固件渠道:正式 sein-pai / 公测 sein-pai-beta */
  model: string
  /** 是否公测渠道:只影响文案与角标,烧录流程完全一致 */
  beta?: boolean
}

export default function FlashUpdater({ model, beta = false }: FlashUpdaterProps) {
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null)
  const [status, setStatus] = useState({ text: '正在获取固件信息...', type: 'working' })

  const [progress, setProgress] = useState<number | null>(null)
  const [transport, setTransport] = useState<any>(null)
  const [esploader, setEsploader] = useState<any>(null)
  const [portSelected, setPortSelected] = useState(false)
  const [flashing, setFlashing] = useState(false)

  const FLASH_ADDRESS = 0x40000
  const NVS_OFFSET = 0x10000
  const NVS_SIZE = 0x20000
  const OTADATA_OFFSET = 0x30000
  const OTADATA_SIZE = 0x2000


  const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator

  useEffect(() => {
    fetch(`/v1/firmware/${model}/latest`)
      .then(res => res.json())
      .then(json => {
        if (json.success) {
          setFirmware(json.data)
          setStatus({ text: '等待选择端口...', type: '' })
        } else {
          setStatus({ text: '获取固件信息失败', type: 'error' })
        }
      })
      .catch(() => setStatus({ text: '获取固件信息失败', type: 'error' }))
  }, [model])

  const handleSelectPort = async () => {
    if (!serialSupported) return
    try {
      setStatus({ text: '正在连接设备...', type: 'working' })
      const { ESPLoader, Transport } = await import('esptool-js')
      const device = await (navigator as any).serial.requestPort()
      const t = new Transport(device, true)

      const term = {
        clean: () => {},
        writeLine: () => {},
        write: () => {},
      }

      const loader = new ESPLoader({
        transport: t,
        baudrate: 921600,
        romBaudrate: 115200,
        terminal: term,
      } as any)

      await loader.main()
      setTransport(t)
      setEsploader(loader)
      setPortSelected(true)
      setStatus({ text: '设备已连接', type: 'success' })
    } catch (err: any) {
      setStatus({ text: '连接失败: ' + (err.message || err), type: 'error' })
      console.error(err)
    }
  }

  const handleFlash = async () => {
    if (!esploader || !firmware) return
    setFlashing(true)
    setProgress(0)

    try {
      setStatus({ text: '正在下载固件文件...', type: 'working' })
      const res = await fetch(firmware.download_url, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`无法加载固件 (${res.status})`)
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)

      // 校验文件大小
      if (firmware.file_size && bytes.length !== firmware.file_size) {
        throw new Error(`固件大小不匹配: 期望 ${firmware.file_size} 字节, 实际 ${bytes.length} 字节`)
      }
      if (bytes.length === 0) {
        throw new Error('下载的固件文件为空')
      }

      // 校验 ESP32 固件魔术字节 (0xE9)
      if (bytes[0] !== 0xE9) {
        throw new Error(`固件格式无效: 首字节 0x${bytes[0].toString(16).padStart(2, '0')}, 期望 0xE9`)
      }

      // 校验 SHA256（如果提供）
      if (firmware.checksum_sha256) {
        const hashBuf = await crypto.subtle.digest('SHA-256', buf)
        const hashArr = Array.from(new Uint8Array(hashBuf))
        const hashHex = hashArr.map(b => b.toString(16).padStart(2, '0')).join('')
        if (hashHex !== firmware.checksum_sha256) {
          throw new Error(`校验失败: SHA256 不匹配`)
        }
      }

      // 读 0x0 检查 bootloader 是否健康。ESP32-S3 image header:
      //   header[0]      = 0xE9 magic
      //   header[12..13] = chip_id (LE),ESP32-S3 = 0x0009
      // 历史上有过 OTA 流程把 bootloader 擦掉的事故,设备进入"factory 完好但 0x0 全 0xFF"
      // 的半砖状态,普通 OTA 写完也启动不了。这里事前自检,触发恢复模式。
      setStatus({ text: '检查设备 bootloader 状态...', type: 'working' })
      let bootloaderOk = false
      try {
        const header = await esploader.readFlash(0x0, 16)
        const magic = header[0]
        const chipId = header[12] | (header[13] << 8)
        bootloaderOk = (magic === 0xE9 && chipId === 0x0009)
        console.log(`Bootloader header: magic=0x${magic.toString(16)} chip_id=0x${chipId.toString(16).padStart(4, '0')} ok=${bootloaderOk}`)
      } catch (e: any) {
        throw new Error('无法读取设备 bootloader 状态: ' + (e?.message || e) + '\n请拔插 USB 重新选端口重试')
      }

      if (!bootloaderOk) {
        // ============ 恢复模式 ============
        if (!firmware.recovery_assets) {
          throw new Error('设备 bootloader 损坏,但当前固件未附带恢复资源。请联系技术支持或用 USB + idf.py flash 恢复。')
        }
        const ok = window.confirm(
          `检测到设备 bootloader 损坏(历史 OTA 出过意外),现在需要完整恢复设备到 v${firmware.version}。\n\n` +
          `约 1.8 MB,30 秒,期间请勿拔出 USB。\n\n` +
          `点 [确定] 开始恢复,点 [取消] 则不写任何东西。`
        )
        if (!ok) {
          throw new Error('用户取消恢复')
        }

        // 下载并校验 3 个恢复资源
        const fetchAndVerify = async (asset: RecoveryAsset, name: string): Promise<Uint8Array> => {
          setStatus({ text: `恢复:正在下载 ${name}...`, type: 'working' })
          const r = await fetch(asset.url, { cache: 'no-cache' })
          if (!r.ok) throw new Error(`无法加载 ${name} (${r.status})`)
          const b = await r.arrayBuffer()
          const u = new Uint8Array(b)
          if (asset.size && u.length !== asset.size) {
            throw new Error(`${name} 大小不匹配: 期望 ${asset.size}, 实际 ${u.length}`)
          }
          if (asset.checksum_sha256) {
            const hb = await crypto.subtle.digest('SHA-256', b)
            const hh = Array.from(new Uint8Array(hb))
              .map(x => x.toString(16).padStart(2, '0')).join('')
            if (hh !== asset.checksum_sha256) {
              throw new Error(`${name} SHA256 不匹配`)
            }
          }
          return u
        }

        const ra = firmware.recovery_assets
        const bootloaderBytes = await fetchAndVerify(ra.bootloader, 'bootloader')
        const partitionBytes = await fetchAndVerify(ra.partition_table, 'partition table')
        const otaDataBytes = await fetchAndVerify(ra.ota_data_initial, 'ota_data_initial')

        // 烧 4 个分区,地址升序:bootloader 先写,中途失败下次 OTA 自检能通过
        setStatus({ text: '恢复:正在完整烧录设备,请勿拔出...', type: 'working' })
        await esploader.writeFlash({
          fileArray: [
            { data: bootloaderBytes, address: ra.bootloader.address },        // 0x00000
            { data: partitionBytes,  address: ra.partition_table.address },   // 0x0F000
            { data: otaDataBytes,    address: ra.ota_data_initial.address },  // 0x30000
            { data: bytes,           address: ra.app.address },               // 0x40000
          ],
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll: false,
          compress: true,
          reportProgress: (_fileIndex: number, written: number, total: number) => {
            setProgress(Math.round((written / total) * 100))
          },
        })
      } else {
        // ============ 正常 OTA 路径 ============
        // 同时擦除 otadata:之前若通过 BLE OTA 升级过,otadata 会指向 ota_0/ota_1,
        // 导致 bootloader 跳过我们刚烧的 factory 分区,新固件不生效。
        const otadataBlank = new Uint8Array(OTADATA_SIZE).fill(0xFF)

        setStatus({ text: '正在更新固件，请勿拔出设备...', type: 'working' })
        // esptool-js 0.6+ 的 fileArray.data 必须是 Uint8Array
        await esploader.writeFlash({
          fileArray: [
            { data: otadataBlank, address: OTADATA_OFFSET },
            { data: bytes, address: FLASH_ADDRESS },
          ],
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll: false,
          compress: true,
          reportProgress: (_fileIndex: number, written: number, total: number) => {
            setProgress(Math.round((written / total) * 100))
          },
        })
      }

      setStatus({ text: '正在重启设备...', type: 'working' })
      // esptool-js 0.6.0 的 HardReset 默认分支只 setRTS(false)，假设 RTS 之前是
      // true，在 USB-Serial-JTAG 上根本拉不低 EN，等于没复位。手动走一次完整
      // RTS toggle：拉低 EN → 等 100ms → 释放，等价于 0.4.x 时代的 hardReset。
      try {
        // ESP32-S3 USB-Serial-JTAG hard reset 时序(对照 esptool.py reset.py HardReset):
        // setRTS(True)拉低 EN → 等 200ms(USB-Serial-JTAG 有 debounce,100ms 不够)
        // → setRTS(False)释放 → 再等 200ms 让 chip boot 起来
        await transport.setRTS(true)
        await new Promise(r => setTimeout(r, 200))
        await transport.setRTS(false)
        await new Promise(r => setTimeout(r, 200))
      } catch (resetErr) {
        // 复位失败不算更新失败：固件已经烧好，告诉用户手动拔插即可
        console.warn('自动重启失败，需手动拔插：', resetErr)
      }
      setStatus({ text: (bootloaderOk ? '更新完成' : '恢复完成') + '，设备已重启', type: 'success' })
    } catch (err: any) {
      setStatus({ text: '更新失败: ' + (err.message || err), type: 'error' })
      console.error(err)
    } finally {
      try { await transport?.disconnect() } catch {}
      setTransport(null)
      setEsploader(null)
      setPortSelected(false)
      setFlashing(false)
    }
  }

  const handleHardReset = async () => {
    if (!esploader || !transport) return
    setFlashing(true)
    try {
      setStatus({ text: '正在重启设备...', type: 'working' })
      // 同 handleFlash 末尾:USB-Serial-JTAG 时序按 esptool.py 来,200ms + 200ms
      await transport.setRTS(true)
      await new Promise(r => setTimeout(r, 200))
      await transport.setRTS(false)
      await new Promise(r => setTimeout(r, 200))
      setStatus({ text: '设备已重启', type: 'success' })
    } catch (err: any) {
      setStatus({ text: '重启失败: ' + (err.message || err), type: 'error' })
      console.error(err)
    } finally {
      try { await transport?.disconnect() } catch {}
      setTransport(null)
      setEsploader(null)
      setPortSelected(false)
      setFlashing(false)
    }
  }

  /** 免重置写色(需固件 v0.5.20+):设备在正常运行态时,通过 CDC 串口命令 SETCOLOR
   *  让固件用自己的 NVS API 写 dev_variant——配对/WiFi 等数据分毫不动,
   *  然后发 REBOOT 重启使广播带上颜色。
   *  注意与上面的 esptool 烧录互斥:这里要的是"跑着固件"的设备,不是下载模式。
   *  (曾用"烧预置 NVS 镜像"方案,整区覆盖等于重置设备,已被本方案取代) */
  const handleWriteColorSerial = async (colorName: string, colorHex: string) => {
    if (!serialSupported) return
    if (!window.confirm(
      `把设备颜色写为「${colorName}」?\n\n` +
      `不清除任何数据(配对/WiFi 保留),需固件 v0.5.20 及以上。\n` +
      `写入后设备自动重启,颜色随广播生效。`
    )) return
    setFlashing(true)
    let port: any = null
    let reader: any = null
    let writer: any = null
    try {
      setStatus({ text: '请在弹窗中选择设备串口...', type: 'working' })
      port = await (navigator as any).serial.requestPort()
      await port.open({ baudRate: 115200 })
      writer = port.writable.getWriter()
      reader = port.readable.getReader()
      const decoder = new TextDecoder()
      const send = (s: string) => writer.write(new TextEncoder().encode(s))

      // 这条口同时是固件日志口,回执混在日志流里,按 #COLOR:/#SYS: 前缀抓取
      const waitFor = async (prefix: string, timeoutMs: number): Promise<string | null> => {
        let acc = ''
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<null>(r => setTimeout(() => r(null), 200)),
          ]) as any
          if (chunk === null) continue
          if (chunk.done) break
          acc += decoder.decode(chunk.value)
          const line = acc.split('\n').find(l => l.includes(prefix))
          if (line) return line.trim()
          if (acc.length > 65536) acc = acc.slice(-1024)
        }
        return null
      }

      setStatus({ text: `正在写入「${colorName}」...`, type: 'working' })
      await send(`SETCOLOR ${colorHex}\n`)
      const resp = await waitFor('#COLOR:', 3000)
      if (!resp) {
        throw new Error('设备未响应。请确认:固件已更新到 v0.5.20+;设备处于开机运行状态(灯亮/可被 App 发现),不是刚做完烧录的下载模式(拔插 USB 一次再试)')
      }
      if (!resp.includes('#COLOR:OK')) throw new Error('设备返回: ' + resp)

      setStatus({ text: '写入成功,正在重启设备...', type: 'working' })
      await send('REBOOT\n')
      await new Promise(r => setTimeout(r, 300))
      setStatus({ text: `设备颜色已写为「${colorName}」并重启,配对不受影响`, type: 'success' })
    } catch (err: any) {
      setStatus({ text: '颜色写入失败: ' + (err.message || err), type: 'error' })
      console.error(err)
    } finally {
      try { reader?.releaseLock() } catch {}
      try { writer?.releaseLock() } catch {}
      try { await port?.close() } catch {}
      setFlashing(false)
    }
  }

  const handleEraseNvs = async () => {
    if (!esploader) return
    if (!window.confirm('确认重置设备?\n\n将清除蓝牙配对、WiFi 配置和用户设置(固件本身不受影响),用于解绑/还原设备。\n操作不可撤销。')) return
    setFlashing(true)
    setProgress(0)

    try {
      setStatus({ text: '正在重置设备...', type: 'working' })
      const blank = new Uint8Array(NVS_SIZE).fill(0xFF)
      await esploader.writeFlash({
        fileArray: [{ data: blank, address: NVS_OFFSET }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex: number, written: number, total: number) => {
          setProgress(Math.round((written / total) * 100))
        },
      })
      setStatus({ text: '正在重启设备...', type: 'working' })
      try {
        // ESP32-S3 USB-Serial-JTAG hard reset 时序(对照 esptool.py reset.py HardReset):
        // setRTS(True)拉低 EN → 等 200ms(USB-Serial-JTAG 有 debounce,100ms 不够)
        // → setRTS(False)释放 → 再等 200ms 让 chip boot 起来
        await transport.setRTS(true)
        await new Promise(r => setTimeout(r, 200))
        await transport.setRTS(false)
        await new Promise(r => setTimeout(r, 200))
      } catch (resetErr) {
        console.warn('自动重启失败:', resetErr)
      }
      setStatus({ text: '设备已重置并重启', type: 'success' })
    } catch (err: any) {
      setStatus({ text: '重置失败: ' + (err.message || err), type: 'error' })
      console.error(err)
    } finally {
      try { await transport?.disconnect() } catch {}
      setTransport(null)
      setEsploader(null)
      setPortSelected(false)
      setFlashing(false)
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>
        Sein PAI 固件更新
        {beta && <span style={styles.betaBadge}>公测</span>}
      </h1>
      <p style={styles.subtitle}>
        请使用 Chrome 或 Edge 浏览器。
        {firmware && (
          <span> 当前{beta ? '公测' : '最新'}版本: <strong>v{firmware.version}</strong></span>
        )}
      </p>
      {beta && (
        <div style={{ ...styles.card, ...styles.betaNotice }}>
          这里是公测渠道，固件更新更快但可能不稳定。
          遇到问题可随时到 <a href="/update" style={styles.betaLink}>正式版页面</a> 刷回稳定版本。
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.actions}>
          <button
            style={{
              ...styles.button,
              ...(!serialSupported ? styles.disabled : {}),
              ...(portSelected ? styles.disabled : {}),
            }}
            disabled={!serialSupported || portSelected || flashing}
            onClick={handleSelectPort}
          >
            1. 选择端口
          </button>
          <button
            style={{
              ...styles.button,
              ...styles.primary,
              ...(!portSelected || flashing ? styles.disabled : {}),
            }}
            disabled={!portSelected || flashing}
            onClick={handleFlash}
          >
            2. 更新设备
          </button>
        </div>
        <p style={styles.tip}>提示：插上设备后点击"选择端口"，在弹窗中选择对应的串口即可。</p>
      </div>

      <div style={styles.card}>
        <p style={styles.sectionTitle}>设备维护（需先连接端口）</p>
        <div style={styles.actions}>
          <button
            style={{
              ...styles.button,
              ...(!portSelected || flashing ? styles.disabled : {}),
            }}
            disabled={!portSelected || flashing}
            onClick={handleHardReset}
          >
            硬重启设备
          </button>
          <button
            style={{
              ...styles.button,
              ...styles.danger,
              ...(!portSelected || flashing ? styles.disabled : {}),
            }}
            disabled={!portSelected || flashing}
            onClick={handleEraseNvs}
          >
            重置设备
          </button>
          <button
            style={{
              ...styles.button,
              ...(portSelected || flashing ? styles.disabled : {}),
            }}
            disabled={portSelected || flashing}
            onClick={() => handleWriteColorSerial('闪光银', '01')}
          >
            写入颜色:闪光银
          </button>
          <button
            style={{
              ...styles.button,
              ...(portSelected || flashing ? styles.disabled : {}),
            }}
            disabled={portSelected || flashing}
            onClick={() => handleWriteColorSerial('亮黑·电镀', '02')}
          >
            写入颜色:亮黑
          </button>
        </div>
        <p style={styles.tip}>硬重启：免拔插重启设备，用于设备开不了机、按键没反应、或灯常亮连不上等卡死情况。重置设备：清除蓝牙配对和 WiFi 配置（固件保留），用于解绑设备、还原设备。写入颜色：把设备外观颜色（银/亮黑）写进设备，App 配对界面按它显示对应外观；<b>不清任何数据</b>，需固件 v0.5.20+ 且设备处于开机运行状态（不用先点"选择端口"，直接点色即可）。</p>
      </div>

      <div style={styles.card}>
        <div style={{
          ...styles.status,
          ...(status.type === 'success' ? styles.statusSuccess : {}),
          ...(status.type === 'error' ? styles.statusError : {}),
          ...(status.type === 'working' ? styles.statusWorking : {}),
        }}>
          {status.text}
        </div>
        {progress !== null && (
          <div style={styles.progressContainer}>
            <div style={{ ...styles.progressBar, width: `${progress}%` }} />
          </div>
        )}
      </div>

      {firmware && (
        <div style={styles.card}>
          <p style={{ margin: '0 0 4px', fontSize: 13, color: '#888' }}>更新说明</p>
          <p style={{ margin: 0, fontSize: 14 }}>{firmware.release_notes}</p>
        </div>
      )}


      {!serialSupported && (
        <div style={{ ...styles.card, ...styles.statusError }}>
          当前浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器。
        </div>
      )}
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    maxWidth: 720,
    margin: '40px auto',
    padding: '0 20px',
    color: '#222',
    background: '#fafafa',
    minHeight: '100vh',
  },
  h1: { fontSize: 24, marginBottom: 8 },
  betaBadge: {
    marginLeft: 10,
    padding: '3px 10px',
    fontSize: 13,
    fontWeight: 500,
    verticalAlign: 'middle',
    borderRadius: 999,
    background: '#fef3c7',
    color: '#92400e',
  },
  betaNotice: {
    background: '#fffbeb',
    borderColor: '#fde68a',
    color: '#92400e',
    fontSize: 13,
    padding: 14,
  },
  betaLink: { color: '#92400e', textDecoration: 'underline' },
  subtitle: { color: '#666', marginBottom: 24, fontSize: 14 },
  card: {
    background: 'white',
    border: '1px solid #e5e5e5',
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
  },
  actions: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  button: {
    padding: '10px 22px',
    fontSize: 15,
    cursor: 'pointer',
    border: '1px solid #d0d0d0',
    background: '#f5f5f5',
    borderRadius: 8,
    color: '#222',
  },
  primary: {
    background: '#2563eb',
    color: 'white',
    borderColor: '#2563eb',
  },
  danger: {
    background: '#fff',
    color: '#b91c1c',
    borderColor: '#fca5a5',
  },
  sectionTitle: {
    margin: '0 0 12px',
    fontSize: 13,
    color: '#666',
    fontWeight: 500,
  },
  disabled: { opacity: 0.45, cursor: 'not-allowed' },
  tip: { color: '#888', fontSize: 12, marginTop: 8 },
  status: {
    padding: '12px 14px',
    background: '#f3f4f6',
    borderRadius: 8,
    fontSize: 14,
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
  },
  statusSuccess: { background: '#dcfce7', color: '#166534' },
  statusError: { background: '#fee2e2', color: '#991b1b' },
  statusWorking: { background: '#fef3c7', color: '#92400e' },
  progressContainer: {
    width: '100%',
    height: 14,
    marginTop: 10,
    borderRadius: 7,
    overflow: 'hidden',
    background: '#e5e7eb',
  },
  progressBar: {
    height: '100%',
    background: '#2563eb',
    borderRadius: 7,
    transition: 'width 0.2s',
  },
}
