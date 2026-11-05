ALTER TABLE "restaurants" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "couriers" ADD COLUMN IF NOT EXISTS "photo" text;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "photo" text;