ALTER TABLE "assignments" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "seen_reminder_at" timestamp with time zone;