// src/app/login/page.tsx
// Sign-in page — handles email/password login.
// Uses Server Actions for secure credential handling.
// Sanitizes redirect destinations and provides safe generic error messages.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSafeRedirectUrl } from '@/lib/utils/url'
import { getSafeAuthErrorMessage, mapSupabaseErrorToCode, logAuthDiagnostic } from '@/lib/utils/auth'

interface LoginPageProps {
  searchParams: Promise<{ error?: string; redirectTo?: string }>
}

async function login(formData: FormData) {
  'use server'
  const supabase = await createClient()
  const email = (formData.get('email') as string)?.trim() ?? ''
  const password = (formData.get('password') as string) ?? ''
  const rawRedirectTo = formData.get('redirectTo') as string
  const safeRedirect = getSafeRedirectUrl(rawRedirectTo, '/chat')

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    const safeErrorCode = mapSupabaseErrorToCode(error.message, false)
    logAuthDiagnostic('login_failure', safeErrorCode, error.status)
    redirect(`/login?error=${encodeURIComponent(safeErrorCode)}&redirectTo=${encodeURIComponent(safeRedirect)}`)
  }

  redirect(safeRedirect)
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const safeErrorMessage = getSafeAuthErrorMessage(params.error)
  const safeRedirect = getSafeRedirectUrl(params.redirectTo, '/chat')

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Sign in to Minimi</h1>

        {safeErrorMessage && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
          >
            {safeErrorMessage}
          </div>
        )}

        <form action={login} className="flex flex-col gap-4">
          <input type="hidden" name="redirectTo" value={safeRedirect} />

          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          <button
            type="submit"
            className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          No account?{' '}
          <Link href="/signup" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
