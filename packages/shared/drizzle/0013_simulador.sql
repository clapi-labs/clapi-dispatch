CREATE TABLE "simulator_controls" (
	"phone_courier_id" integer PRIMARY KEY NOT NULL,
	"sim_courier_id" integer,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulator_controls_sim_courier_id_unique" UNIQUE("sim_courier_id")
);
--> statement-breakpoint
ALTER TABLE "couriers" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "simulator_controls" ADD CONSTRAINT "simulator_controls_phone_courier_id_couriers_id_fk" FOREIGN KEY ("phone_courier_id") REFERENCES "public"."couriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulator_controls" ADD CONSTRAINT "simulator_controls_sim_courier_id_couriers_id_fk" FOREIGN KEY ("sim_courier_id") REFERENCES "public"."couriers"("id") ON DELETE set null ON UPDATE no action;