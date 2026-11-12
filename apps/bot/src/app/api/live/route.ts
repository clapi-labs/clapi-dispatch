export const dynamic = "force-dynamic";

/**
 * ¿El proceso del bot está vivo? Para el healthcheck de Docker (y así para
 * `deploy.sh`, que espera a que los contenedores estén sanos). No revisa la
 * base, el worker ni el engine: eso es `/api/health`, para el monitoreo externo.
 * Caddy no la expone: solo se llama desde dentro del contenedor.
 */
export function GET() {
  return Response.json({ ok: true });
}
