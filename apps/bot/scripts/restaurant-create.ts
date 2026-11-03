/**
 * Registra un restaurante (o lo actualiza si el número ya existe). Desde ahí,
 * cuando escribe por WhatsApp el bot ya sabe quién es y dónde se recoge.
 *
 *   npm run restaurant:create -- 573001234567 "Monkeys" "Cra 100 # 11-60, Ciudad Jardín"
 *
 * La dirección se geocodifica aquí, una sola vez, con GOOGLE_MAPS_API_KEY.
 * Sin llave (o si Google no la ubica) se pueden dar las coordenadas a mano:
 *
 *   npm run restaurant:create -- 573001234567 "Monkeys" "Cra 100 # 11-60" --lat 3.3712 --lng -76.5362
 */
async function main() {
  const { saveRestaurant } = await import("@dispatch/shared/db");
  const { geocodeAddress } = await import("../src/services/google/geocode");

  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return null;
    const [, value] = args.splice(i, 2);
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`--${name} debe ser un número`);
    return n;
  };
  const lat = flag("lat");
  const lng = flag("lng");
  const [phone, name, address] = args;

  if (!phone || !name || !address) {
    throw new Error('Uso: npm run restaurant:create -- <número> "<nombre>" "<dirección de recogida>" [--lat <lat> --lng <lng>]');
  }
  if ((lat === null) !== (lng === null)) throw new Error("Se necesitan --lat y --lng juntas.");

  let location: { lat: number; lng: number } | null = lat !== null && lng !== null ? { lat, lng } : null;

  if (!location) {
    const geocoded = await geocodeAddress(address);
    if (geocoded.kind === "found") {
      location = geocoded.location;
    } else {
      const why = {
        not_found: "Google no ubicó la dirección con precisión",
        failed: "Google no respondió",
        disabled: "no hay GOOGLE_MAPS_API_KEY",
      }[geocoded.kind];
      throw new Error(`No se pudo ubicar la dirección (${why}). Revísala o pasa --lat y --lng.`);
    }
  }

  const { restaurant, created } = await saveRestaurant({ phone, name, pickupAddress: address, pickupLocation: location });
  console.log(
    `${created ? "Restaurante registrado" : "Restaurante actualizado"}: ${restaurant.name} (${restaurant.phone})\n` +
      `Recoge en: ${restaurant.knownPickupAddress} → ${location.lat}, ${location.lng}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
