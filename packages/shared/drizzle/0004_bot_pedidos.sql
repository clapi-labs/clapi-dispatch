ALTER TABLE "trips" ALTER COLUMN "customer_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "value_to_collect" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "payment_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "requires_cash_return" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "processed_through_message_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "trip_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "incoming" jsonb;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "source_wa_message_id" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_wa_message_idx" ON "messages" USING btree ("wa_message_id");--> statement-breakpoint
-- Lo que ya estaba en la base se da por respondido: sin esto, el primer
-- mensaje nuevo de cada conversación arrastraría todo su historial.
UPDATE "conversations" SET "processed_through_message_id" = (SELECT max("id") FROM "messages" WHERE "messages"."conversation_id" = "conversations"."id");
