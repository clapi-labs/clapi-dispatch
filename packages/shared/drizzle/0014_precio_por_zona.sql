CREATE TABLE "price_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"min_price" integer,
	"ring" jsonb NOT NULL,
	"barrio_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
