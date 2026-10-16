// Limpieza semanal del Área general: cada lunes a las 0:00 (Guadalajara) las actividades de cosas ya terminadas
// salen de «Actividad del equipo» y pasan a su «Historial». No se borran: se marcan con `archivada` y la limpieza
// queda en el historial del panel de administración.
// Terminado = tarea en su etapa final (Publicada / Entregada) o borrada; entrega aprobada, en la papelera o borrada.
import { guardarDelServidor } from './entidades.js';
import { estadoDe, ajustesAprobacion, equipo } from './entregas.js';
import { registrar } from './bitacora.js';

// Debe coincidir con el cron de wrangler.jsonc: lunes 06:00 UTC = lunes 0:00 en Guadalajara.
// (Vive aquí y no en index.js: el módulo principal de un Worker solo puede exportar manejadores.)
export const CRON_SEMANAL = '0 6 * * 1';

// Etapas finales de fábrica (por si Dirección no ha cambiado los estados).
const FINALES = { redes: ['publicada'], diseno: ['entregada'] };

async function filas(env, tipo) {
	const r = await env.DB.prepare('SELECT id, datos, borrado FROM entidades WHERE tipo = ?1').bind(tipo).all();
	return new Map((r.results || []).map((f) => [f.id, { borrado: !!f.borrado, datos: JSON.parse(f.datos) }]));
}

export async function archivarTerminadas(env, ahora = new Date()) {
	const finales = { ...FINALES };
	for (const [id, f] of await filas(env, 'stat')) {
		const v = f.datos && Array.isArray(f.datos.v) ? f.datos.v : null;
		if (!f.borrado && v) finales[id] = v.filter((s) => s && s.final).map((s) => s.k);
	}
	const tareas = await filas(env, 'task'), entregas = await filas(env, 'entrega');
	const aj = await ajustesAprobacion(env), usuarios = await equipo(env);
	const terminada = (o) => {
		if (!o || typeof o.id !== 'string') return false;
		if (o.tipo === 'task') {
			const t = tareas.get(o.id);
			return !t || t.borrado || (finales[t.datos.type] || []).includes(t.datos.status);
		}
		if (o.tipo === 'entrega') {
			const e = entregas.get(o.id);
			return !e || e.borrado || !!e.datos.borrada || estadoDe(e.datos, usuarios, aj) === 'aprobada';
		}
		return false; // pendientes de junta y lo demás se quedan
	};
	const en = ahora.toISOString();
	let n = 0;
	for (const [id, a] of await filas(env, 'actividad')) {
		if (a.borrado || a.datos.archivada || !terminada(a.datos.objeto)) continue;
		await guardarDelServidor(env, 'actividad', id, (x) => (x && !x.archivada ? { ...x, archivada: { en } } : undefined), 'servidor');
		n++;
	}
	if (n) await registrar(env, 'servidor', 'Limpieza semanal', `${n} ${n === 1 ? 'actividad terminada pasó' : 'actividades terminadas pasaron'} al historial del Área general`);
	return n;
}
