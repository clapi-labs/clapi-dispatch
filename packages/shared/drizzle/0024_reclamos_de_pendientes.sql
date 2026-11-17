CREATE TABLE "return_debt_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"restaurant_id" integer,
	"restaurant_name" text NOT NULL,
	"conversation_id" integer,
	"reason" text,
	"closing" boolean DEFAULT false NOT NULL,
	"why" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by_user_id" integer
);
--> statement-breakpoint
ALTER TABLE "return_debts" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_debts" ADD COLUMN "closing_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_debt_claims" ADD CONSTRAINT "return_debt_claims_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debt_claims" ADD CONSTRAINT "return_debt_claims_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_debt_claims" ADD CONSTRAINT "return_debt_claims_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_debt_claims_open_idx" ON "return_debt_claims" USING btree ("handled_at","created_at");--> statement-breakpoint
-- Avisos en vivo (como en la 0003 y la 0021): el portal se entera al momento de los reclamos.
DROP TRIGGER IF EXISTS return_debt_claims_notify_change ON "return_debt_claims";
--> statement-breakpoint
CREATE TRIGGER return_debt_claims_notify_change AFTER INSERT OR UPDATE OR DELETE ON "return_debt_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();