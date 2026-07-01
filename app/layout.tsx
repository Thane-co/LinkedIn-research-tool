// Layer 5 — root layout (Next.js App Router).
import type { ReactNode } from 'react'

export const metadata = {
  title: 'Viral Post Research Tool',
  description: 'Local research tool for finding viral social posts.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
