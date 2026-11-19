-- Retención automática (issue #103): la limpieza de webhooks atendidos busca
-- por fecha.
CREATE INDEX IF NOT EXISTS "processed_messages_processed_at_idx" ON "processed_messages" USING btree ("processed_at");
--> statement-breakpoint
-- Avisos en vivo de los chats con el chat (issue #103, H2): un INSERT o UPDATE
-- de `messages` avisa "messages:<id>,<id>" con los chats que tocó, y el portal
-- vuelve a pedir el hilo abierto solo si es uno de esos. Sigue siendo un aviso
-- por sentencia. Con más de 20 chats a la vez (o en un borrado, como el de la
-- retención) avisa "messages" a secas, que vale para todos; un UPDATE que no
-- tocó ninguna fila no avisa.
CREATE OR REPLACE FUNCTION notify_messages_change() RETURNS trigger AS $$
DECLARE
  chats int;
  ids text;
BEGIN
  SELECT count(DISTINCT conversation_id), string_agg(DISTINCT conversation_id::text, ',')
    INTO chats, ids
    FROM changed_messages;
  IF chats = 0 THEN
    RETURN NULL;
  END IF;
  IF chats <= 20 THEN
    PERFORM pg_notify('dispatch_changes', 'messages:' || ids);
  ELSE
    PERFORM pg_notify('dispatch_changes', 'messages');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_notify_change ON "messages";
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_insert_notify_change ON "messages";
--> statement-breakpoint
CREATE TRIGGER messages_insert_notify_change AFTER INSERT ON "messages"
  REFERENCING NEW TABLE AS changed_messages
  FOR EACH STATEMENT EXECUTE FUNCTION notify_messages_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_update_notify_change ON "messages";
--> statement-breakpoint
CREATE TRIGGER messages_update_notify_change AFTER UPDATE ON "messages"
  REFERENCING NEW TABLE AS changed_messages
  FOR EACH STATEMENT EXECUTE FUNCTION notify_messages_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_delete_notify_change ON "messages";
--> statement-breakpoint
CREATE TRIGGER messages_delete_notify_change AFTER DELETE ON "messages"
  FOR EACH STATEMENT EXECUTE FUNCTION notify_dispatch_change();
