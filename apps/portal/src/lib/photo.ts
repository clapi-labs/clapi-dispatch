/** Lo que acepta el servidor como foto: el JPEG pequeño que arma `PhotoButton`, o nada para quitarla. */
export function isValidPhoto(photo: unknown): photo is string | null {
  return photo === null || (typeof photo === "string" && photo.startsWith("data:image/jpeg;base64,") && photo.length < 200_000);
}
