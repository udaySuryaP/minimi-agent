// src/app/chat/page.tsx
// Chat landing page — placeholder for Phase 2.
// Protected by the proxy auth guard.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function ChatPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold">Minimi</h1>
      <p className="text-zinc-500">Signed in as {user.email}</p>
      <p className="text-sm text-zinc-400">
        Chat interface coming in Phase 2.
      </p>
    </div>
  )
}
