CREATE TABLE "demand_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"previous" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics" jsonb NOT NULL,
	"config" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"level" text DEFAULT 'baja' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_since" timestamp with time zone,
	"measured_at" timestamp with time zone,
	"signal" text,
	"metrics" jsonb
);
--> statement-breakpoint
ALTER TABLE "engine_evaluations" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "engine_evaluations" ADD COLUMN "demand" jsonb;--> statement-breakpoint
CREATE INDEX "demand_changes_at_idx" ON "demand_changes" USING btree ("at");--> statement-breakpoint
-- Las evaluaciones de antes ya traían el modo en la respuesta del engine.
UPDATE "engine_evaluations" SET "mode" = "response" ->> 'modo'
  WHERE "mode" IS NULL AND "response" ->> 'modo' IN ('pico', 'valle');
--> statement-breakpoint
-- Avisos en vivo (como en la 0003): el portal se entera al momento de un cambio
-- de nivel, o de que empieza o se corta la cuenta para cambiar. El tick
-- actualiza demand_state cada pocos segundos; por eso el aviso va por fila y
-- solo cuando cambia algo de eso, no con cada medición.
DROP TRIGGER IF EXISTS demand_state_notify_change ON "demand_state";
--> statement-breakpoint
CREATE TRIGGER demand_state_notify_change AFTER UPDATE ON "demand_state"
  FOR EACH ROW
  WHEN (OLD."level" IS DISTINCT FROM NEW."level" OR OLD."candidate_since" IS DISTINCT FROM NEW."candidate_since")
  EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS demand_changes_notify_change ON "demand_changes";
--> statement-breakpoint
CREATE TRIGGER demand_changes_notify_change AFTER INSERT ON "demand_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
