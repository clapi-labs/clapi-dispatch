CREATE TABLE "restricted_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"ring" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
