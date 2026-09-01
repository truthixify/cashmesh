import { Writable } from "node:stream";
import { CashuPaymentRequestIssuer } from "@cashmesh/cashu";
import { operatorId } from "@cashmesh/domain";
import { afterEach, describe, expect, it } from "vitest";

import { type BuildAppOptions, buildApp } from "../src/app";
import { InvoiceRepositoryError } from "../src/invoice-repository";
import { FakeInvoiceRepository } from "./fake-invoice-repository";

const NOW = 1_788_000_000;
const EXPIRES_AT = NOW + 300;
const CASHU_PAYMENT_REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: "https://mint-a.cashmesh.example",
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
    {
      mintUrl: "https://mint-b.cashmesh.example",
      operatorId: operatorId("operator-b"),
      tier: "convertible",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("acquirer API", () => {
  it("reports service health", async () => {
    const { app } = createApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "acquirer-api", status: "ok" });
  });

  it("returns the bounded settlement decision", async () => {
    const { app } = createApp();

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
    const { app } = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/operator-policy/evaluate",
      payload: { tier: "preferred" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "invalid_request", message: "Request validation failed." },
    });
  });

  it("creates an open invoice with a server identity and timestamp", async () => {
    const { app } = createApp();

    const response = await createInvoice(app, "checkout-001");

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["idempotency-replayed"]).toBe("false");
    expect(response.headers.location).toBe("/v1/merchants/merchant-001/invoices/inv_test-0001");
    expect(response.json()).toMatchObject({
      cashuPaymentRequest: {
        amount: 1_234,
        encoding: "creqA",
        expiresAt: EXPIRES_AT,
        invoiceId: "inv_test-0001",
        issuedAt: NOW,
        mintPolicy: "strict",
        operators: [
          {
            mintUrl: "https://mint-a.cashmesh.example",
            mode: "trusted_hold",
            operatorId: "operator-a",
            reason: "trusted_operator",
            tier: "trusted",
          },
          {
            mintUrl: "https://mint-b.cashmesh.example",
            mode: "immediate_conversion",
            operatorId: "operator-b",
            reason: "conversion_required",
            tier: "convertible",
          },
        ],
        schemaVersion: 1,
        transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
        unit: "usdc",
      },
      invoice: {
        amount: 1_234,
        createdAt: NOW,
        expiresAt: EXPIRES_AT,
        id: "inv_test-0001",
        merchantId: "merchant-001",
        schemaVersion: 1,
        state: "open",
        unit: "usdc",
      },
      replayed: false,
    });
    expect(response.json().cashuPaymentRequest.encodedRequest).toMatch(/^creqA/);
  });

  it("returns the original invoice for an exact idempotent replay", async () => {
    const { app, repository } = createApp();
    const first = await createInvoice(app, "checkout-001");
    const replay = await createInvoice(app, "checkout-001");

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(repository.invoices).toHaveLength(1);
  });

  it("retries a generated invoice identifier collision", async () => {
    const generatedIds = ["invoice-collision", "invoice-collision", "invoice-retry"];
    const { app, repository } = createApp({
      invoiceIdFactory: () => generatedIds.shift() ?? "invoice-unexpected",
    });
    await createInvoice(app, "checkout-001");

    const response = await createInvoice(app, "checkout-002");

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ invoice: { id: "invoice-retry" } });
    expect(repository.invoices.size).toBe(2);
  });

  it("replays the original response after the invoice expiry time", async () => {
    let currentTime = NOW;
    const { app } = createApp({ clock: () => currentTime });
    const first = await createInvoice(app, "checkout-001");
    currentTime = EXPIRES_AT + 1;

    const replay = await createInvoice(app, "checkout-001");

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
  });

  it("rejects reusing an idempotency key for different invoice terms", async () => {
    const { app } = createApp();
    await createInvoice(app, "checkout-001");

    const conflict = await createInvoice(app, "checkout-001", { amount: 1_235 });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was already used for a different invoice request.",
      },
    });
  });

  it("reads invoices only through their owning merchant path", async () => {
    const { app } = createApp();
    await createInvoice(app, "checkout-001");

    const found = await app.inject({
      method: "GET",
      url: "/v1/merchants/merchant-001/invoices/inv_test-0001",
    });
    const hidden = await app.inject({
      method: "GET",
      url: "/v1/merchants/merchant-002/invoices/inv_test-0001",
    });

    expect(found.statusCode).toBe(200);
    expect(found.headers["cache-control"]).toBe("no-store");
    expect(found.json()).toMatchObject({ invoice: { id: "inv_test-0001" } });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({
      error: { code: "invoice_not_found", message: "Invoice was not found." },
    });
  });

  it("projects only declared checkout fields into the response", async () => {
    const { app, repository } = createApp();
    await createInvoice(app, "checkout-001");
    const stored = repository.invoices.get("inv_test-0001");
    if (stored === undefined) {
      throw new Error("Expected test invoice to exist.");
    }
    repository.invoices.set("inv_test-0001", {
      ...stored,
      cashuPaymentRequest: {
        ...stored.cashuPaymentRequest,
        internalRouteSecret: "must-not-leak",
      },
      internalNote: "must-not-leak",
    } as typeof stored);

    const response = await app.inject({
      method: "GET",
      url: "/v1/merchants/merchant-001/invoices/inv_test-0001",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("internalNote");
    expect(response.body).not.toContain("internalRouteSecret");
    expect(response.body).not.toContain("must-not-leak");
  });

  it("does not write merchant or invoice identifiers to automatic request logs", async () => {
    let logOutput = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += String(chunk);
        callback();
      },
    });
    const { app } = createApp({ logger: { level: "info", stream: destination } });
    await createInvoice(app, "checkout-sensitive");

    await app.inject({
      method: "GET",
      url: "/v1/merchants/merchant-001/invoices/inv_test-0001",
    });

    expect(logOutput).not.toContain("merchant-001");
    expect(logOutput).not.toContain("inv_test-0001");
    expect(logOutput).not.toContain("checkout-sensitive");
  });

  it.each([
    { name: "missing idempotency key", headers: {}, payload: invoicePayload() },
    {
      name: "fractional amount",
      headers: { "idempotency-key": "checkout-001" },
      payload: invoicePayload({ amount: 12.34 }),
    },
    {
      name: "undeclared metadata",
      headers: { "idempotency-key": "checkout-001" },
      payload: { ...invoicePayload(), customerEmail: "customer@example.invalid" },
    },
  ])("rejects $name at the HTTP schema boundary", async ({ headers, payload }) => {
    const { app } = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/merchants/merchant-001/invoices",
      headers,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "invalid_request", message: "Request validation failed." },
    });
  });

  it("rejects an invoice that does not expire after server creation time", async () => {
    const { app } = createApp();

    const response = await createInvoice(app, "checkout-001", { expiresAt: NOW });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_invoice",
        message: "Invoice expiry must be after the current server time.",
      },
    });
  });

  it("redacts repository failures and closes storage with the app", async () => {
    const { app, repository } = createApp();
    repository.failure = new InvoiceRepositoryError(
      "storage_unavailable",
      "postgresql://user:secret@database.invalid/cashmesh",
    );

    const response = await createInvoice(app, "checkout-001");

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
    expect(response.json()).toEqual({
      error: { code: "storage_unavailable", message: "Invoice storage is unavailable." },
    });
    await app.close();
    expect(repository.closed).toBe(true);
    apps.splice(apps.indexOf(app), 1);
  });

  it("does not persist an invoice when Cashu request issuance fails", async () => {
    const { app, repository } = createApp({
      cashuPaymentRequestIssuer: {
        issue: () => {
          throw new Error("operator configuration contains secret-value");
        },
      },
    });

    const response = await createInvoice(app, "checkout-001");

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret-value");
    expect(response.json()).toEqual({
      error: {
        code: "payment_request_unavailable",
        message: "Cashu payment request could not be issued.",
      },
    });
    expect(repository.invoices.size).toBe(0);
  });
});

function createApp(
  options: {
    readonly cashuPaymentRequestIssuer?: Pick<CashuPaymentRequestIssuer, "issue">;
    readonly clock?: () => number;
    readonly invoiceIdFactory?: () => string;
    readonly logger?: BuildAppOptions["logger"];
  } = {},
) {
  const repository = new FakeInvoiceRepository();
  let invoiceSequence = 0;
  const app = buildApp({
    cashuPaymentRequestIssuer: options.cashuPaymentRequestIssuer ?? CASHU_PAYMENT_REQUEST_ISSUER,
    clock: options.clock ?? (() => NOW),
    invoiceIdFactory:
      options.invoiceIdFactory ??
      (() => {
        invoiceSequence += 1;
        return `inv_test-${String(invoiceSequence).padStart(4, "0")}`;
      }),
    invoiceRepository: repository,
    ...(options.logger !== undefined && { logger: options.logger }),
  });
  apps.push(app);
  return { app, repository };
}

function createInvoice(
  app: ReturnType<typeof buildApp>,
  requestKey: string,
  bodyOverrides: Partial<CreateInvoiceBody> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/merchants/merchant-001/invoices",
    headers: { "idempotency-key": requestKey },
    payload: invoicePayload(bodyOverrides),
  });
}

interface CreateInvoiceBody {
  readonly amount: number;
  readonly expiresAt: number;
}

function invoicePayload(overrides: Partial<CreateInvoiceBody> = {}): CreateInvoiceBody {
  return { amount: 1_234, expiresAt: EXPIRES_AT, ...overrides };
}
