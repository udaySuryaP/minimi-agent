// src/app/page.tsx
// Root page — redirects authenticated users to chat, others to login.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function RootPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/chat')
  } else {
    redirect('/login')
  }
}
