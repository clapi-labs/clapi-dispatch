ALTER TABLE "trips" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "cancel_fee" integer;