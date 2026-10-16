// Historial de cambios sensibles para el panel de administración. Cada fila: cuándo, quién, qué y el detalle.
// Vive en su propia tabla (no en `entidades`) para que no se sincronice a las pantallas del resto del equipo.

export async function registrar(env, por, accion, detalle = '') {
	try {
		await env.DB.prepare('INSERT INTO bitacora (t, por, accion, detalle) VALUES (?1, ?2, ?3, ?4)')
			.bind(new Date().toISOString(), String(por || ''), String(accion).slice(0, 120), String(detalle || '').slice(0, 1000)).run();
	} catch (e) {
		console.error('bitacora', e); // el historial nunca debe impedir el cambio
	}
}

export async function listar(env, limite = 300) {
	const r = await env.DB.prepare('SELECT t, por, accion, detalle FROM bitacora ORDER BY id DESC LIMIT ?1').bind(limite).all();
	return r.results || [];
}

const NIVEL = (u) => (u && u.nivel === 'administracion' ? 'Administración' : 'sin nivel especial');
const ROL = { admin: 'Dirección', community: 'Community', diseno: 'Diseño', '': 'por definir' };
const rol = (r) => ROL[r || ''] || r;

// Qué cambió de una persona, en palabras. `antes` o `despues` en null = alta o eliminación.
export function describirPersona(antes, despues) {
	const nombre = (despues || antes || {}).name || (despues || antes || {}).id || '';
	if (!antes) return { accion: 'Alta de persona', detalle: `${nombre} (${rol(despues.role)}${despues.nivel === 'administracion' ? ', Administración' : ''})` };
	if (!despues) return { accion: 'Persona eliminada', detalle: nombre };
	const cambios = [];
	if (!!antes.baja !== !!despues.baja) return { accion: despues.baja ? 'Baja de persona' : 'Persona reactivada', detalle: nombre };
	if ((antes.nivel || '') !== (despues.nivel || '')) cambios.push(`nivel: ${NIVEL(antes)} → ${NIVEL(despues)}`);
	if ((antes.role || '') !== (despues.role || '')) cambios.push(`rol: ${rol(antes.role)} → ${rol(despues.role)}`);
	if (!!antes.aprueba !== !!despues.aprueba) cambios.push(despues.aprueba ? 'ahora aprueba entregas' : 'ya no aprueba entregas');
	if ((antes.email || '') !== (despues.email || '')) cambios.push('cambió su correo de acceso');
	if ((antes.name || '') !== (despues.name || '')) cambios.push(`nombre: ${antes.name} → ${despues.name}`);
	return cambios.length ? { accion: 'Permisos de persona', detalle: `${nombre}: ${cambios.join('; ')}` } : null;
}

export function describirAjuste(id, antes, despues) {
	if (id === 'aprobacion') {
		const d = despues || {};
		return { accion: 'Reglas de aprobación', detalle: `${d.regla === 'todos' ? 'deben aprobar todas las personas que aprueban' : 'basta con una persona'}; quien sube ${d.autorAprueba ? 'sí' : 'no'} puede aprobar lo suyo` };
	}
	return { accion: 'Ajuste', detalle: id };
}
