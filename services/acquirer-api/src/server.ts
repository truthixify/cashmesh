import { buildApp } from "./app";
import { PostgresInvoiceRepository } from "./postgres-invoice-repository";

const LOCAL_DATABASE_URL = "postgresql://cashmesh:cashmesh_local@127.0.0.1:5432/cashmesh";

function readDatabaseUrl(value: string | undefined): string {
  if (value !== undefined && value.trim() !== "") {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("CASHMESH_DATABASE_URL is required in production.");
  }
  return LOCAL_DATABASE_URL;
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3100");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ACQUIRER_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

try {
  await startServer();
} catch (error) {
  process.stderr.write(
    `CashMesh acquirer API failed to start: ${error instanceof Error ? error.name : "UnknownError"}\n`,
  );
  process.exitCode = 1;
}

async function startServer(): Promise<void> {
  const port = readPort(process.env.ACQUIRER_PORT);
  const invoiceRepository = await PostgresInvoiceRepository.connect({
    connectionString: readDatabaseUrl(process.env.CASHMESH_DATABASE_URL),
    onBackgroundError: (error) => {
      process.stderr.write(`CashMesh PostgreSQL idle client failed: ${error.name}\n`);
    },
  });
  const app = buildApp({ invoiceRepository, logger: true });

  try {
    await app.listen({ host: process.env.ACQUIRER_HOST ?? "127.0.0.1", port });
  } catch (error) {
    await app.close();
    throw error;
  }
}
