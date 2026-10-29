ALTER TABLE "trips" ALTER COLUMN "customer_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "value_to_collect" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "payment_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "requires_cash_return" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "trip_id" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "source_wa_message_id" text;--> statement-breakpoint
CREATE INDEX "messages_wa_message_idx" ON "messages" USING btree ("wa_message_id");