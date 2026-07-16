import { NextResponse, type NextRequest } from "next/server"

import { loadRoutineArtifactData } from "@/lib/routines/load-routine-artifact-data"
import { hasCurrentAppAccess } from "@/lib/billing/subscriptions"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { createTrackerApiHandlers } from "@/lib/tracking/api-handlers"

const handlers = createTrackerApiHandlers({
  createAuthClient: createClient,
  createAdminClient,
  hasCurrentAppAccess,
  loadRoutineArtifactData,
})

export async function GET(request: NextRequest) {
  const tz = request.nextUrl.searchParams.get("tz") ?? "Europe/Berlin"
  const result = await handlers.getTracker({ tz })
  return NextResponse.json(result.body, { status: result.status })
}
