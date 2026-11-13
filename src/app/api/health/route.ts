// src/app/api/health/route.ts
// Public health check endpoint — no authentication required.

import { NextResponse } from 'next/server'

export function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
}
