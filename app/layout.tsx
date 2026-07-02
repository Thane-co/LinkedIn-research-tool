// Layer 5 — root layout (Next.js App Router). Global styles (design system, PRD §11.7) load here.
import './globals.css'
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
