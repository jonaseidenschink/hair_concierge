import { notFound } from "next/navigation"

import { AppProofFixture, type AppProofState } from "./app-proof-fixture"

const STATES = new Set<AppProofState>(["routine", "product", "chat"])

export default async function AppProofPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  if (process.env.NODE_ENV !== "development") notFound()

  const state = (await searchParams).state ?? "routine"
  if (!STATES.has(state as AppProofState)) notFound()

  return <AppProofFixture state={state as AppProofState} />
}
