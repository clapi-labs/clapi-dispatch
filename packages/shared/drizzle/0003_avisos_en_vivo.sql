-- Avisos en vivo: cada vez que cambian estas tablas, Postgres avisa por el
-- canal "dispatch_changes" con el nombre de la tabla. El portal escucha
-- (LISTEN) y le pide al tablero que se actualice solo cuando hace falta.
-- Un aviso por sentencia, no por fila: un UPDATE de 20 viajes avisa una vez.
CREATE OR REPLACE FUNCTION notify_dispatch_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('dispatch_changes', TG_TABLE_NAME);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trips_notify_change ON "trips";
--> statement-breakpoint
CREATE TRIGGER trips_notify_change AFTER INSERT OR UPDATE OR DELETE ON "trips"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS assignments_notify_change ON "assignments";
--> statement-breakpoint
CREATE TRIGGER assignments_notify_change AFTER INSERT OR UPDATE OR DELETE ON "assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS couriers_notify_change ON "couriers";
--> statement-breakpoint
CREATE TRIGGER couriers_notify_change AFTER INSERT OR UPDATE OR DELETE ON "couriers"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS conversations_notify_change ON "conversations";
--> statement-breakpoint
CREATE TRIGGER conversations_notify_change AFTER INSERT OR UPDATE OR DELETE ON "conversations"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_notify_change ON "messages";
--> statement-breakpoint
CREATE TRIGGER messages_notify_change AFTER INSERT OR UPDATE OR DELETE ON "messages"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
