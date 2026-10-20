import { apiRequest } from "./client"

const cache = new Map<string, string>()

/** Fetches and caches a local capability token. Tokens are signed by the server. */
export async function capabilityToken(capId: string): Promise<string> {
  const cached = cache.get(capId)
  if (cached) return cached
  const response = await apiRequest<{ token: string }>(
    `/api/capabilities/${encodeURIComponent(capId)}/token`,
  )
  cache.set(capId, response.token)
  return response.token
}

export async function capabilityHeaders(capId: string): Promise<Record<string, string>> {
  return { "x-cg-capability": await capabilityToken(capId) }
}
