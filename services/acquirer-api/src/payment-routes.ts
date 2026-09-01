import { MAX_NUT18_PAYMENT_PAYLOAD_BYTES } from "@cashmesh/cashu";
import type { FastifyInstance } from "fastify";

import type { PaymentIntakeService } from "./payment-intake-service";

export const CASHU_PAYMENT_ROUTE = "/v1/cashu/payments";

export function registerPaymentRoutes(app: FastifyInstance, service: PaymentIntakeService): void {
  app.register((paymentScope, _options, done) => {
    paymentScope.removeAllContentTypeParsers();
    paymentScope.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    paymentScope.addContentTypeParser(
      "application/json",
      { bodyLimit: MAX_NUT18_PAYMENT_PAYLOAD_BYTES, parseAs: "string" },
      (_request, body, parseDone) => parseDone(null, body),
    );
    paymentScope.post<{ Body: string }>(CASHU_PAYMENT_ROUTE, async (request) => {
      await service.inspect(request.body);
    });
    done();
  });
}
