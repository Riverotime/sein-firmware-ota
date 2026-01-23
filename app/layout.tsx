export const metadata = {
  title: 'Sein Firmware OTA Service',
  description: 'Firmware update service for Sein devices',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
