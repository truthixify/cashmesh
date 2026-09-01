import type { FastifyInstance } from "fastify";

import type { InvoiceService } from "./invoice-service";

interface CreateInvoiceBody {
  readonly amount: number;
  readonly expiresAt: number;
}

interface CreateInvoiceHeaders {
  readonly "idempotency-key": string;
}

interface InvoiceParams {
  readonly invoiceId: string;
  readonly merchantId: string;
}

const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const invoiceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merchantId"],
  properties: {
    merchantId: { type: "string", pattern: IDENTIFIER_PATTERN },
  },
} as const;

const invoiceLookupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merchantId", "invoiceId"],
  properties: {
    merchantId: { type: "string", pattern: IDENTIFIER_PATTERN },
    invoiceId: { type: "string", pattern: IDENTIFIER_PATTERN },
  },
} as const;

const createInvoiceHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", pattern: IDENTIFIER_PATTERN },
  },
} as const;

const createInvoiceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "expiresAt"],
  properties: {
    amount: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    expiresAt: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
  },
} as const;

const openInvoiceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "amount",
    "createdAt",
    "expiresAt",
    "id",
    "merchantId",
    "schemaVersion",
    "state",
    "unit",
  ],
  properties: {
    amount: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    createdAt: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
    expiresAt: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
    id: { type: "string", pattern: IDENTIFIER_PATTERN },
    merchantId: { type: "string", pattern: IDENTIFIER_PATTERN },
    schemaVersion: { type: "integer", const: 1 },
    state: { type: "string", const: "open" },
    unit: { type: "string", const: "usdc" },
  },
} as const;

const createInvoiceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["invoice", "replayed"],
  properties: {
    invoice: openInvoiceSchema,
    replayed: { type: "boolean" },
  },
} as const;

const findInvoiceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["invoice"],
  properties: { invoice: openInvoiceSchema },
} as const;

export function registerInvoiceRoutes(app: FastifyInstance, service: InvoiceService): void {
  app.post<{
    Body: CreateInvoiceBody;
    Headers: CreateInvoiceHeaders;
    Params: Pick<InvoiceParams, "merchantId">;
  }>(
    "/v1/merchants/:merchantId/invoices",
    {
      schema: {
        body: createInvoiceBodySchema,
        headers: createInvoiceHeadersSchema,
        params: invoiceParamsSchema,
        response: { 200: createInvoiceResponseSchema, 201: createInvoiceResponseSchema },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const result = await service.create({
        amount: request.body.amount,
        expiresAt: request.body.expiresAt,
        idempotencyKey: request.headers["idempotency-key"],
        merchantId: request.params.merchantId,
      });
      const location = `/v1/merchants/${encodeURIComponent(
        result.invoice.merchantId,
      )}/invoices/${encodeURIComponent(result.invoice.id)}`;
      return reply
        .code(result.replayed ? 200 : 201)
        .header("idempotency-replayed", String(result.replayed))
        .header("location", location)
        .send({ invoice: result.invoice, replayed: result.replayed });
    },
  );

  app.get<{ Params: InvoiceParams }>(
    "/v1/merchants/:merchantId/invoices/:invoiceId",
    {
      schema: {
        params: invoiceLookupParamsSchema,
        response: { 200: findInvoiceResponseSchema },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const invoice = await service.find(request.params);
      if (invoice === undefined) {
        return reply.code(404).send({
          error: { code: "invoice_not_found", message: "Invoice was not found." },
        });
      }
      return reply.send({ invoice });
    },
  );
}
