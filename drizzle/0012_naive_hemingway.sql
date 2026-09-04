ALTER TABLE "agent_test_case" ADD COLUMN "tool_trace" jsonb;--> statement-breakpoint
-- 017 (edicion manual) — El anti-solape ahora tambien cubre al Laboratorio.
--
-- Hasta 0011 el EXCLUDE excluia is_test: las reservas de prueba no consumian
-- flota real (bien) pero tampoco se estorbaban entre si (mal) — dos personas
-- simuladas podian quedarse con la misma maquina y el Lab jamas veria el
-- conflicto que en produccion si ocurre. Meter is_test en la clave separa los
-- dos mundos SIN renunciar a la garantia en ninguno: real con real y prueba
-- con prueba se excluyen; real con prueba, no.
ALTER TABLE "rental" DROP CONSTRAINT IF EXISTS "rental_no_overlap";--> statement-breakpoint
ALTER TABLE "rental" ADD CONSTRAINT "rental_no_overlap"
  EXCLUDE USING gist ("unit_id" WITH =, "is_test" WITH =, "period" WITH &&)
  WHERE (status IN ('tentativa','confirmada','en_curso'));
