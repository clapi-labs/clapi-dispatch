CREATE TABLE "service_zone_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"zone_id" integer NOT NULL,
	"action" text NOT NULL,
	"name" text NOT NULL,
	"ring" jsonb NOT NULL,
	"barrio_code" text,
	"user_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ring" jsonb NOT NULL,
	"barrio_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_zone_versions" ADD CONSTRAINT "service_zone_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_zone_versions_zone_idx" ON "service_zone_versions" USING btree ("zone_id");