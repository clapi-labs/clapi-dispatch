-- Las zonas sin cobertura y las de precio mínimo dejan de existir: la central
-- marca solo las zonas donde sí hay servicio (0018, service_zones).
DROP TABLE IF EXISTS "price_zones" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "restricted_zones" CASCADE;
