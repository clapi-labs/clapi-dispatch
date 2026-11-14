ALTER TABLE "service_zone_versions" ADD COLUMN "fare_adjustment" integer;--> statement-breakpoint
ALTER TABLE "service_zones" ADD COLUMN "fare_adjustment" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "fare_table_price" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "fare_adjustment" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "fare_zone_name" text;