// src/app/signup/confirm/page.tsx
// Post-signup confirmation page — shown after email is submitted.

import Link from 'next/link'

export default function ConfirmPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm text-center">
        <div className="mb-6 text-5xl">📬</div>
        <h1 className="mb-3 text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mb-6 text-sm text-zinc-500">
          We sent a confirmation link to your email address. Click it to activate your account.
        </p>
        <Link
          href="/login"
          className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
