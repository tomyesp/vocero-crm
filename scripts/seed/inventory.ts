/**
 * 017 — CLI del seed de inventario: `pnpm seed:inventario`.
 * Idempotente (borra y recarga el inventario de la organización).
 * Se bundlea con esbuild (alias @ → ./src), igual que el seed demo.
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { seedInventory } from "@/server/seed/inventory";

function loadEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const env = readFileSync(".env", "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

const url = loadEnvVar("DATABASE_URL");
if (!url) {
  console.error("[seed] DATABASE_URL no está definida");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(sql, { schema });

const orgs = await db.select().from(schema.organization).limit(1);
const org = orgs[0];
if (!org) {
  console.error(
    "[seed] No hay organización: registrate primero en la app y volvé a correr el seed"
  );
  await sql.end();
  process.exit(1);
}

const result = await seedInventory(db, org.id);
console.log(
  `[seed] Inventario RPM cargado: ${result.categories} categorías, ${result.models} modelos, ${result.units} unidades, ${result.rates} tarifas, ${result.rentals} reservas`
);
await sql.end();
process.exit(0);
