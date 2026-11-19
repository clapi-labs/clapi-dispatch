ALTER TABLE "messages" ADD COLUMN "media_path" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_mime" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_bytes" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_width" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_height" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_expired_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_expired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_media_stored_idx" ON "messages" USING btree ("created_at") WHERE "messages"."media_status" = 'stored';