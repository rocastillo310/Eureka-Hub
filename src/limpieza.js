// Limpieza diaria (corre con el mismo cron que el respaldo, 3:00 a. m. en Guadalajara).
// Las notas de la pizarra que llevan 7 días o más en la papelera se borran para siempre.
import { guardarDelServidor } from './entidades.js';

export const DIAS_PAPELERA_NOTAS = 7;

export async function vaciarPapeleraNotas(env, ahora = new Date()) {
	const limite = new Date(ahora.getTime() - DIAS_PAPELERA_NOTAS * 864e5).toISOString();
	const r = await env.DB.prepare(
		"SELECT id FROM entidades WHERE tipo = 'note' AND borrado = 0 AND json_extract(datos, '$.borrada.en') IS NOT NULL AND json_extract(datos, '$.borrada.en') <= ?1",
	).bind(limite).all();
	const ids = (r.results || []).map((f) => f.id);
	// Se vuelve a revisar al borrar: si alguien la restauró en medio, no se toca.
	for (const id of ids) {
		await guardarDelServidor(env, 'note', id, (actual) => (actual && actual.borrada && actual.borrada.en <= limite ? null : undefined), 'servidor');
	}
	return ids.length;
}
