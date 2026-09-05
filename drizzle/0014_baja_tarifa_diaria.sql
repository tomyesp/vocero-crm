-- 017 (fork RPM) — Se van las columnas del modelo diario.
--
-- Va separada de la 0013 porque el orden importa: primero se rellena
-- `hourly_cents` desde `daily_cents`, y recien despues se puede borrar la
-- fuente. Juntas, un rollback a mitad de camino se lleva los precios.
ALTER TABLE "rate_card" DROP COLUMN "daily_cents";--> statement-breakpoint
ALTER TABLE "rate_card" DROP COLUMN "weekly_cents";--> statement-breakpoint
ALTER TABLE "rate_card" DROP COLUMN "monthly_cents";--> statement-breakpoint
ALTER TABLE "rate_card" DROP COLUMN "operator_daily_cents";