CREATE TABLE "machine_category" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_model" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_operator" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_unit" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"model_id" text NOT NULL,
	"internal_code" text NOT NULL,
	"year" integer,
	"usage_hours" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'operativa' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_card" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"model_id" text NOT NULL,
	"daily_cents" bigint NOT NULL,
	"weekly_cents" bigint,
	"monthly_cents" bigint,
	"transfer_base_cents" bigint DEFAULT 0 NOT NULL,
	"transfer_per_km_cents" bigint DEFAULT 0 NOT NULL,
	"operator_daily_cents" bigint DEFAULT 0 NOT NULL,
	"valid_from" timestamp DEFAULT now() NOT NULL,
	"valid_to" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rental" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"kind" text DEFAULT 'alquiler' NOT NULL,
	"contact_id" text,
	"conversation_id" text,
	"period" "tstzrange" NOT NULL,
	"status" text DEFAULT 'tentativa' NOT NULL,
	"expires_at" timestamp,
	"created_by" text DEFAULT 'humano' NOT NULL,
	"quoted_amount_cents" bigint,
	"with_transfer" boolean DEFAULT false NOT NULL,
	"site_location" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rental_offer" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"model_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"period" "tstzrange" NOT NULL,
	"quoted_amount_cents" bigint NOT NULL,
	"label" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_category" ADD CONSTRAINT "machine_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_model" ADD CONSTRAINT "machine_model_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_model" ADD CONSTRAINT "machine_model_category_id_machine_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."machine_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_unit" ADD CONSTRAINT "machine_unit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_unit" ADD CONSTRAINT "machine_unit_model_id_machine_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."machine_model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_model_id_machine_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."machine_model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental" ADD CONSTRAINT "rental_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental" ADD CONSTRAINT "rental_unit_id_machine_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."machine_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental" ADD CONSTRAINT "rental_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental" ADD CONSTRAINT "rental_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_offer" ADD CONSTRAINT "rental_offer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_offer" ADD CONSTRAINT "rental_offer_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_offer" ADD CONSTRAINT "rental_offer_model_id_machine_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."machine_model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_offer" ADD CONSTRAINT "rental_offer_unit_id_machine_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."machine_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_category_org_slug_uq" ON "machine_category" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "machine_model_org_cat_idx" ON "machine_model" USING btree ("organization_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_unit_org_code_uq" ON "machine_unit" USING btree ("organization_id","internal_code");--> statement-breakpoint
CREATE INDEX "machine_unit_org_model_idx" ON "machine_unit" USING btree ("organization_id","model_id");--> statement-breakpoint
CREATE INDEX "rate_card_org_model_from_idx" ON "rate_card" USING btree ("organization_id","model_id","valid_from");--> statement-breakpoint
CREATE INDEX "rental_org_status_idx" ON "rental" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "rental_unit_idx" ON "rental" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "rental_org_conv_idx" ON "rental" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "rental_offer_conv_idx" ON "rental_offer" USING btree ("conversation_id","expires_at");--> statement-breakpoint
-- 017 (edicion manual): anti-solape ATOMICO de reservas por unidad.
-- Drizzle no sabe declarar constraints de EXCLUSION; este bloque se agrega a
-- mano a la migracion generada. btree_gist permite mezclar la igualdad de
-- unit_id con el solape (&&) del rango en el mismo indice GiST.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- Solo los estados que ocupan flota bloquean; canceladas y finalizadas no.
-- Las reservas del Laboratorio (is_test) quedan fuera: nunca consumen flota
-- real. No lleva organization_id: unit_id ya es unico global (nanoid).
ALTER TABLE "rental" ADD CONSTRAINT "rental_no_overlap"
  EXCLUDE USING gist ("unit_id" WITH =, "period" WITH &&)
  WHERE (status IN ('tentativa','confirmada','en_curso') AND is_test = false);
