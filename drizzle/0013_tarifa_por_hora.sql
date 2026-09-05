-- 017 (fork RPM) — Tarifas por HORA DE MÁQUINA.
--
-- RPM cotiza la hora, no el día, y su catálogo está en neto con el operario y
-- el combustible ya adentro. Esta migración agrega lo nuevo y RELLENA lo que
-- había; la 0014 borra las columnas del modelo diario, después de que nadie
-- las necesite.
--
-- Las dos altas NOT NULL van en dos pasos a propósito: un `ADD COLUMN ... NOT
-- NULL` sin default revienta cualquier base que ya tenga filas, y este repo
-- corre las migraciones al ARRANCAR el contenedor — una migración que falla
-- deja la app abajo, no un aviso.
ALTER TABLE "machine_model" ALTER COLUMN "requires_operator" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "hourly_cents" bigint;--> statement-breakpoint
-- Una jornada eran 8 horas: es la única conversión que no inventa un precio.
UPDATE "rate_card" SET "hourly_cents" = round("daily_cents" / 8.0) WHERE "hourly_cents" IS NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ALTER COLUMN "hourly_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "min_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Las reservas viejas se cotizaron por día: quedan en NULL en vez de fingir
-- una jornada que nadie pactó.
ALTER TABLE "rental" ADD COLUMN "hours_per_day" integer;--> statement-breakpoint
-- Las ofertas vivas duran 30 minutos: el default es un puente, no un dato.
ALTER TABLE "rental_offer" ADD COLUMN "hours_per_day" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "rental_offer" ALTER COLUMN "hours_per_day" DROP DEFAULT;
