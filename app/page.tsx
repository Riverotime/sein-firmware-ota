export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Sein Firmware OTA Service</h1>
      <p style={{ color: '#666' }}>API endpoints:</p>
      <ul style={{ lineHeight: 2 }}>
        <li><code>GET /v1/firmware/{'{model}'}/latest</code> - Get latest firmware info</li>
        <li><code>GET /v1/firmware/{'{model}'}/check?current={'{version}'}</code> - Check for updates</li>
        <li><code>GET /v1/firmware/{'{model}'}/{'{version}'}</code> - Get specific version info</li>
        <li><code>GET /v1/firmware/{'{model}'}/versions</code> - List all versions</li>
      </ul>
      <p style={{ marginTop: '2rem', color: '#999', fontSize: '0.875rem' }}>
        Supported models: sein-pai
      </p>
    </main>
  )
}
