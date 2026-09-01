import { buildApp } from "./app";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3100");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ACQUIRER_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

const app = buildApp({ logger: true });

try {
  await app.listen({
    host: process.env.ACQUIRER_HOST ?? "127.0.0.1",
    port: readPort(process.env.ACQUIRER_PORT),
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
