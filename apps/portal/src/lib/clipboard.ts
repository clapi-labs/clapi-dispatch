/**
 * Copia texto al portapapeles. `navigator.clipboard` solo existe en páginas
 * seguras (https o localhost): probando desde el celular por la IP del
 * computador no está, y ahí se cae al truco del campo de texto oculto.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Sin permiso o sin foco: se intenta por el otro camino.
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
