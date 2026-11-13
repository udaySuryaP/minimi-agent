// src/app/signup/page.tsx
// Sign-up page — creates a new account via Supabase Auth.
// Saves validated IANA timezone (with Asia/Kolkata fallback) to the user profile.
// Uses Server Actions for secure credential handling.
// Sanitizes user-facing error messages to prevent raw internal leaks.

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { sanitizeTimezone } from '@/lib/utils/timezone'
import { getSafeAuthErrorMessage, mapSupabaseErrorToCode } from '@/lib/utils/auth'

interface SignupPageProps {
  searchParams: Promise<{ error?: string }>
}

async function signup(formData: FormData) {
  'use server'
  const supabase = await createClient()
  const email = (formData.get('email') as string)?.trim() ?? ''
  const password = (formData.get('password') as string) ?? ''
  const displayName = (formData.get('displayName') as string)?.trim() ?? ''

  // Validate the client-submitted timezone against IANA identifiers; fallback to Asia/Kolkata
  const rawTimezone = formData.get('timezone')
  const timezone = sanitizeTimezone(rawTimezone, 'Asia/Kolkata')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: displayName || email.split('@')[0],
        timezone,
      },
      emailRedirectTo: `${appUrl}/auth/callback`,
    },
  })

  if (error) {
    // Diagnostic log on server side only — never log credentials or sensitive data
    console.error('[auth/signup failure]', {
      status: error.status,
      name: error.name,
      message: error.message,
    })

    const safeErrorCode = mapSupabaseErrorToCode(error.message, true)
    redirect(`/signup?error=${encodeURIComponent(safeErrorCode)}`)
  }

  // Show confirmation page after successful signup (email confirmation flow)
  redirect('/signup/confirm')
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams
  const safeErrorMessage = getSafeAuthErrorMessage(params.error)

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Create your account</h1>

        {safeErrorMessage && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
          >
            {safeErrorMessage}
          </div>
        )}

        <form action={signup} className="flex flex-col gap-4">
          {/* Timezone is populated by the inline script below and validated on submission */}
          <input type="hidden" name="timezone" id="timezone-field" value="Asia/Kolkata" />

          <div className="flex flex-col gap-1">
            <label htmlFor="displayName" className="text-sm font-medium">
              Name
            </label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              autoComplete="name"
              placeholder="Your name"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

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
              autoComplete="new-password"
              minLength={8}
              placeholder="At least 8 characters"
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          <button
            type="submit"
            className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Create account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-zinc-900 underline dark:text-zinc-100">
            Sign in
          </Link>
        </p>
      </div>

      {/* Detect browser timezone on first load; validated server-side on submit */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            try {
              var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              if (tz) document.getElementById('timezone-field').value = tz;
            } catch(e) {}
          `,
        }}
      />
    </div>
  )
}
