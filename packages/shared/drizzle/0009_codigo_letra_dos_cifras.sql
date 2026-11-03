ALTER SEQUENCE "public"."trip_code_seq" INCREMENT BY 1 MINVALUE 0 MAXVALUE 2599 START WITH 0 CACHE 1 CYCLE RESTART WITH 0;--> statement-breakpoint
ALTER TABLE "trips" DROP CONSTRAINT "trips_code_unique";--> statement-breakpoint
CREATE INDEX "trips_conversation_code_idx" ON "trips" USING btree ("conversation_id","code");