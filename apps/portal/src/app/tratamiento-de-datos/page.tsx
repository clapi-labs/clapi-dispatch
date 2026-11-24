import type { Metadata } from "next";

import { GPS_CONSENT_VERSION } from "@dispatch/shared/db";

import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: `Tratamiento de datos · ${BRAND.client.name}` };

/**
 * Página pública: la política de tratamiento de datos de los domiciliarios
 * (Ley 1581 de 2012, Decreto 1377 de 2013). El bot la enlaza en el mensaje de
 * consentimiento de la activación (`consentPromptText`), así el mensaje queda
 * corto y lo largo de la ley vive aquí.
 *
 * Los datos de contacto del responsable no van en el repositorio (es público):
 * se ponen en el `.env` del servidor (PRIVACY_*). Los que falten no se muestran,
 * y el WhatsApp de la central queda siempre como canal.
 */
function responsible() {
  const value = (key: string) => process.env[key]?.trim() || null;
  return {
    name: value("PRIVACY_OWNER_NAME") ?? BRAND.client.name,
    nit: value("PRIVACY_OWNER_NIT"),
    address: value("PRIVACY_OWNER_ADDRESS"),
    email: value("PRIVACY_OWNER_EMAIL"),
    phone: value("PRIVACY_OWNER_PHONE"),
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

export default function TratamientoDeDatosPage() {
  const owner = responsible();
  const contact = [
    owner.email && `el correo ${owner.email}`,
    owner.phone && `el teléfono ${owner.phone}`,
    "el mismo chat de WhatsApp de la central",
  ].filter(Boolean);

  return (
    <main className="min-h-full bg-canvas px-4 py-10">
      <article className="mx-auto w-full max-w-2xl space-y-6 rounded-2xl bg-surface p-6 shadow-sm sm:p-8">
        <header className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{owner.name}</p>
          <h1 className="text-xl font-semibold text-ink">Política de tratamiento de datos de los domiciliarios</h1>
          <p className="text-sm text-ink-3">Ley 1581 de 2012 y Decreto 1377 de 2013 · Versión {GPS_CONSENT_VERSION}</p>
        </header>

        <Section title="1. Quién es el responsable">
          <p>
            El responsable del tratamiento de tus datos es <strong>{owner.name}</strong>
            {owner.nit && <>, NIT {owner.nit}</>}
            {owner.address && <>, con domicilio en {owner.address}</>}. La plataforma que coordina los domicilios la opera Clapi Solutions como encargado,
            siguiendo sus instrucciones.
          </p>
        </Section>

        <Section title="2. Qué datos usamos">
          <ul className="list-disc space-y-1 pl-5">
            <li>Tu nombre y tu número de celular.</li>
            <li>Los mensajes que nos escribes por WhatsApp y los botones que tocas.</li>
            <li>Tu ubicación GPS, solo mientras tienes la app Traccar Client encendida en tu turno.</li>
            <li>Las horas de cada servicio: cuándo se te asignó, recogiste y entregaste.</li>
            <li>La prueba de esta autorización: la fecha, la versión de esta política y el mensaje con que aceptaste.</li>
          </ul>
        </Section>

        <Section title="3. Para qué los usamos">
          <ul className="list-disc space-y-1 pl-5">
            <li>Asignarte los servicios, empezando por los que te quedan más cerca.</li>
            <li>Confirmar cuándo llegas al restaurante y al cliente, y avisarles a ellos.</li>
            <li>Calcular rutas y tiempos de entrega.</li>
            <li>Llevar la cuenta de tus servicios y cuadrar los pagos.</li>
            <li>Atenderte cuando reportas una novedad, y la seguridad de la operación.</li>
          </ul>
          <p>No vendemos tus datos ni los usamos para publicidad.</p>
        </Section>

        <Section title="4. Tu ubicación">
          <p>
            Solo recibimos tu ubicación mientras la app está encendida. Guardamos únicamente tu última posición, y se borra sola cuando pasas 24 horas
            sin reportar. Al terminar tu turno apagas la app y escribes «desactivado».
          </p>
        </Section>

        <Section title="5. Con quién se comparten">
          <p>
            Solo con los proveedores que hacen funcionar el servicio: Meta (WhatsApp), para los mensajes, y el proveedor de servidores en la nube,
            que los guarda en Alemania. Ellos los tratan solo para prestar ese servicio. Si una autoridad competente los pide, los entregamos según la
            ley.
          </p>
        </Section>

        <Section title="6. Tus derechos">
          <p>Como titular de tus datos puedes:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Conocer, actualizar y corregir tus datos.</li>
            <li>Pedir la prueba de esta autorización.</li>
            <li>Saber para qué se han usado tus datos.</li>
            <li>Revocar la autorización o pedir que se borren tus datos, si no hay un deber legal de conservarlos.</li>
            <li>Presentar quejas ante la Superintendencia de Industria y Comercio.</li>
          </ul>
        </Section>

        <Section title="7. Cómo ejercerlos">
          <p>Escríbenos por {contact.join(", o por ")}.</p>
          <p>
            Respondemos las consultas en máximo 10 días hábiles y los reclamos en máximo 15 días hábiles. Si revocas la autorización, no podrás seguir
            recibiendo servicios por la plataforma, porque la ubicación es necesaria para asignarlos.
          </p>
        </Section>

        <Section title="8. Cuánto tiempo los guardamos">
          <p>
            Mientras trabajes con {owner.name} y el tiempo que exija la ley para la contabilidad de los servicios. Tu ubicación, como máximo 24
            horas.
          </p>
        </Section>

        <Section title="9. Cambios a esta política">
          <p>Si la cambiamos, te avisamos por WhatsApp y te pedimos tu autorización de nuevo cuando el cambio lo requiera.</p>
        </Section>
      </article>
    </main>
  );
}
