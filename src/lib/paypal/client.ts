import "server-only"

type OAuthTokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number
}

let cachedToken: { token: string; expiresAt: number } | null = null

export class PayPalRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "PayPalRequestError"
  }
}

export function getPayPalBaseUrl(): string {
  const environment = process.env.PAYPAL_ENVIRONMENT?.toLowerCase()
  if (!environment) throw new Error("PAYPAL_ENVIRONMENT is not set")
  if (environment === "live") return "https://api-m.paypal.com"
  if (environment === "sandbox") return "https://api-m.sandbox.paypal.com"
  throw new Error("PAYPAL_ENVIRONMENT must be either sandbox or live")
}

export async function paypalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getPayPalAccessToken()
  let response: Response
  try {
    response = await fetch(`${getPayPalBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
    })
  } catch (error) {
    throw new PayPalRequestError("PayPal request failed before a response was received", null, {
      cause: error,
    })
  }

  if (!response.ok) {
    throw new PayPalRequestError(
      `PayPal request failed (${response.status} ${response.statusText}): ${await readBody(response)}`,
      response.status,
    )
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function getPayPalAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token

  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId) throw new Error("PAYPAL_CLIENT_ID is not set")
  if (!clientSecret) throw new Error("PAYPAL_CLIENT_SECRET is not set")

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  })

  if (!response.ok) {
    throw new Error(
      `PayPal OAuth failed (${response.status} ${response.statusText}): ${await readBody(response)}`,
    )
  }

  const token = (await response.json()) as OAuthTokenResponse
  if (!token.access_token) throw new Error("PayPal OAuth response did not include access_token")

  cachedToken = {
    token: token.access_token,
    expiresAt: Date.now() + Math.max(0, token.expires_in ?? 0) * 1000,
  }
  return cachedToken.token
}

async function readBody(response: Response): Promise<string> {
  const text = await response.text()
  return text || "<empty body>"
}
