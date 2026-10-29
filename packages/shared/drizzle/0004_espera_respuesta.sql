ALTER TABLE "conversations" ADD COLUMN "processed_through_message_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "incoming" jsonb;--> statement-breakpoint
-- Lo que ya estaba en la base se da por respondido: sin esto, el primer
-- mensaje nuevo de cada conversación arrastraría todo su historial.
UPDATE "conversations" SET "processed_through_message_id" = (SELECT max("id") FROM "messages" WHERE "messages"."conversation_id" = "conversations"."id");
