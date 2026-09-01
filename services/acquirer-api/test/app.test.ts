import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("acquirer API", () => {
  it("reports service health", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "acquirer-api", status: "ok" });
  });

  it("returns the bounded settlement decision", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/operator-policy/evaluate",
      payload: { tier: "convertible", requestedMode: "trusted_hold" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: true,
      mode: "immediate_conversion",
      reason: "conversion_required",
    });
  });

  it("rejects unknown policy values before domain evaluation", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/operator-policy/evaluate",
      payload: { tier: "preferred" },
    });

    expect(response.statusCode).toBe(400);
  });
});
