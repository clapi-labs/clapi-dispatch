ALTER TABLE "courier_profiles" ADD COLUMN "gps_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD COLUMN "gps_consent_version" text;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD COLUMN "gps_consent_wa_message_id" text;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD COLUMN "onboarding_completed_at" timestamp with time zone;