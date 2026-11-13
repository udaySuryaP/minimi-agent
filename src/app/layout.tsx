import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Minimi — Temporal Memory Research Agent',
  description:
    'An AI-powered conversational research agent with temporal memory and historical comparison.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50 font-sans">
        {children}
      </body>
    </html>
  )
}
