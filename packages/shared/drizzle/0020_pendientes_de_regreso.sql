CREATE TABLE "return_debts" (
	"id" serial PRIMARY KEY NOT NULL,
	"courier_id" integer NOT NULL,
	"restaurant_id" integer,
	"restaurant_name" text NOT NULL,
	"reason" text NOT NULL,
	"trip_id" integer,
	"declared_by" text NOT NULL,
	"declared_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminder_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_by_user_id" integer
);
--> statement-breakpoint
ALTER TABLE "return_debts" ADD CONSTRAINT "return_debts_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debts" ADD CONSTRAINT "return_debts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debts" ADD CONSTRAINT "return_debts_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debts" ADD CONSTRAINT "return_debts_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debts" ADD CONSTRAINT "return_debts_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_debts_trip_reason_idx" ON "return_debts" USING btree ("trip_id","reason") WHERE "return_debts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "return_debts_open_idx" ON "return_debts" USING btree ("courier_id","resolved_at");--> statement-breakpoint
-- Avisos en vivo (como en la 0003): el portal se entera de los pendientes al momento.
DROP TRIGGER IF EXISTS return_debts_notify_change ON "return_debts";
--> statement-breakpoint
CREATE TRIGGER return_debts_notify_change AFTER INSERT OR UPDATE OR DELETE ON "return_debts"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
-- Ya no existe «Volviendo»: el servicio termina al entregar. Lo que estuviera de
-- regreso al desplegar se da por terminado (no se sabe por qué volvía, así que
-- no se crea un pendiente: si el restaurante reclama, la central lo registra a
-- mano), y la moto que solo tenía eso queda libre.
UPDATE "assignments" SET "finished_at" = now()
  WHERE "return_started_at" IS NOT NULL AND "finished_at" IS NULL;
--> statement-breakpoint
UPDATE "couriers" SET "status" = 'available'
  WHERE "status" = 'busy'
    AND NOT EXISTS (
      SELECT 1 FROM "assignments" a JOIN "trips" t ON t."id" = a."trip_id"
      WHERE a."courier_id" = "couriers"."id" AND t."status" IN ('assigned', 'en_route')
    );
