CREATE TABLE "engine_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"reason" text,
	"courier_id" integer,
	"faltan_min" real,
	"dispatch_at" timestamp with time zone,
	"engine_version" text,
	"request" jsonb,
	"response" jsonb,
	"evaluations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "engine_evaluations" ADD CONSTRAINT "engine_evaluations_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_evaluations" ADD CONSTRAINT "engine_evaluations_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "engine_evaluations_trip_idx" ON "engine_evaluations" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "engine_evaluations_status_idx" ON "engine_evaluations" USING btree ("status");