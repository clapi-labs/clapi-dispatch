CREATE TABLE "assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"courier_id" integer,
	"courier_name" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"display_name" text,
	"bot_paused" boolean DEFAULT false NOT NULL,
	"escalation_reason" text,
	"draft" jsonb,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "courier_profiles" (
	"courier_id" integer PRIMARY KEY NOT NULL,
	"vehicle_plate" text,
	"vehicle_type" text,
	"document_id" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "couriers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"lat" real,
	"lng" real,
	"location_updated_at" timestamp with time zone,
	"deliveries_this_shift" integer DEFAULT 0 NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"shift_started_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"courier_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"score_breakdown" jsonb,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "fares" (
	"id" serial PRIMARY KEY NOT NULL,
	"origin_zone_id" integer NOT NULL,
	"destination_zone_id" integer NOT NULL,
	"price" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"wa_message_id" text,
	"extraction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"wa_message_id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restaurants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"known_pickup_address" text,
	"known_pickup_location" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurants_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"restaurant_id" integer,
	"conversation_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"origin_restaurant_name" text NOT NULL,
	"pickup_address" text,
	"pickup_location" jsonb,
	"delivery_address" text NOT NULL,
	"delivery_location" jsonb,
	"customer_phone" text NOT NULL,
	"value_to_collect" integer NOT NULL,
	"delivery_fee" integer DEFAULT 0 NOT NULL,
	"pickup_zone" text,
	"delivery_zone" text,
	"payment_method" text NOT NULL,
	"requires_cash_return" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "zones_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fares" ADD CONSTRAINT "fares_origin_zone_id_zones_id_fk" FOREIGN KEY ("origin_zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fares" ADD CONSTRAINT "fares_destination_zone_id_zones_id_fk" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_trip_idx" ON "assignments" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "dispatch_offers_trip_idx" ON "dispatch_offers" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "dispatch_offers_pending_idx" ON "dispatch_offers" USING btree ("expires_at","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "fares_pair_idx" ON "fares" USING btree ("origin_zone_id","destination_zone_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "restaurants_phone_idx" ON "restaurants" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "trips_status_idx" ON "trips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trips_restaurant_idx" ON "trips" USING btree ("restaurant_id");