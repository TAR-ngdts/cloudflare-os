import { describe, expect, it, vi } from "vitest";
import { NgDotsGatewayClient, type NgDotsCredentials } from "../src/client";

describe("NgDotsGatewayClient", () => {
  it("refreshes and retries one unauthorized gateway request", async () => {
    let credentials: NgDotsCredentials = { accessToken: "old", refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "session_expired" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new", refresh_token: "refresh-2", expires_in: 900 }))
      .mockResolvedValueOnce(Response.json({ apps: [] }));
    const client = new NgDotsGatewayClient("https://gateway.example.test", {
      load: async () => credentials,
      save: async next => { credentials = next; },
      expired: async () => {},
    }, fetchImpl);

    await expect(client.call("/api/apps")).resolves.toEqual({ apps: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(credentials.refreshToken).toBe("refresh-2");
  });

  it("rejects paths outside the plugin API contract", async () => {
    const client = new NgDotsGatewayClient("https://gateway.example.test", {
      load: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 60_000 }),
      save: async () => {},
      expired: async () => {},
    });
    await expect(client.call("/admin/users")).rejects.toThrow("unsupported_gateway_path");
  });
});
