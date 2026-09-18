export type NgDotsCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export interface NgDotsCredentialStore {
  load(): Promise<NgDotsCredentials>;
  save(credentials: NgDotsCredentials): Promise<void>;
  expired(): Promise<void>;
}

type Fetch = typeof fetch;

export class NgDotsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function normalizeGatewayUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("NG Dots gateway must use HTTPS (except localhost development)." );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("NG Dots gateway URL must not contain credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function validatePath(path: string): void {
  if (!/^\/(api|auth)\/[A-Za-z0-9_?=&%./-]+$/.test(path) || path.includes("..")) {
    throw new Error("unsupported_gateway_path");
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => ({ error: "gateway_response_invalid" }));
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data
      ? String((data as { error: unknown }).error)
      : `gateway_${response.status}`;
    throw new NgDotsApiError(message, response.status);
  }
  return data;
}

export async function exchangeNgDotsCode(
  gatewayUrl: string,
  code: string,
  verifier: string,
  fetchImpl: Fetch = fetch,
): Promise<NgDotsCredentials> {
  const response = await fetchImpl(`${normalizeGatewayUrl(gatewayUrl)}/plugin/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
    redirect: "error",
  });
  const data = await responseJson(response) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw new Error("gateway_token_response_invalid");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export class NgDotsGatewayClient {
  readonly #gatewayUrl: string;
  readonly #store: NgDotsCredentialStore;
  readonly #fetch: Fetch;
  #refreshing?: Promise<NgDotsCredentials>;

  constructor(gatewayUrl: string, store: NgDotsCredentialStore, fetchImpl: Fetch = fetch) {
    this.#gatewayUrl = normalizeGatewayUrl(gatewayUrl);
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  async #refresh(credentials: NgDotsCredentials): Promise<NgDotsCredentials> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const response = await this.#fetch(`${this.#gatewayUrl}/plugin/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refreshToken }),
        redirect: "error",
      });
      try {
        const data = await responseJson(response) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };
        const next = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
        await this.#store.save(next);
        return next;
      } catch (error) {
        if (error instanceof NgDotsApiError && error.status === 401) await this.#store.expired();
        throw error;
      }
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    validatePath(path);
    let credentials = await this.#store.load();
    if (credentials.expiresAt < Date.now() + 30_000) credentials = await this.#refresh(credentials);

    const send = (token: string) => this.#fetch(`${this.#gatewayUrl}/plugin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });

    let response = await send(credentials.accessToken);
    if (response.status === 401) {
      credentials = await this.#refresh(credentials);
      response = await send(credentials.accessToken);
    }
    return await responseJson(response) as T;
  }
}
