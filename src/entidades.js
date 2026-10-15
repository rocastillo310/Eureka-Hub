// Lectura y escritura de filas de `entidades`, compartida por /api/sync y por las rutas que escribe solo el servidor
// (entregas y actividad). Cada escritura sube el `seq` global para que las pantallas reciban el cambio en su próximo sync.

export const aEntidad = (f) => ({
	tipo: f.tipo, id: f.id, datos: f.borrado ? null : JSON.parse(f.datos), version: f.version, seq: f.seq, creado: f.creado, borrado: !!f.borrado,
});

// Inserta (cur vacío) o actualiza con control optimista (misma `version` que se leyó). Devuelve true si escribió.
export async function escribir(env, c, cur, datosTexto, borrado, por) {
	const ahora = new Date().toISOString();
	const incremento = env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1');
	let sentencia;
	if (!cur) {
		sentencia = env.DB.prepare(
			'INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) ' +
			'SELECT ?1, ?2, ?3, 1, seq, seq, ?4, 0, ?5 FROM contador WHERE id = 1 ON CONFLICT (tipo, id) DO NOTHING',
		).bind(c.tipo, c.id, datosTexto, ahora, por);
	} else {
		sentencia = env.DB.prepare(
			'UPDATE entidades SET datos = ?3, version = version + 1, seq = (SELECT seq FROM contador WHERE id = 1), borrado = ?4, actualizado = ?5, por = ?6 ' +
			'WHERE tipo = ?1 AND id = ?2 AND version = ?7',
		).bind(c.tipo, c.id, datosTexto, borrado ? 1 : 0, ahora, por, cur.version);
	}
	const res = await env.DB.batch([incremento, sentencia]);
	return res[1].meta.changes === 1;
}

export async function leerEntidad(env, tipo, id) {
	const f = await env.DB.prepare('SELECT datos, version, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
	if (!f) return null;
	return { datos: f.borrado ? null : JSON.parse(f.datos), version: f.version, borrado: !!f.borrado };
}

// Cambio hecho por el servidor: `mutar(actual)` recibe los datos de hoy (o null si no existe) y devuelve los nuevos,
// `null` para borrar, o `undefined` para no tocar nada. Se reintenta si alguien escribió el mismo elemento en medio.
export async function guardarDelServidor(env, tipo, id, mutar, por) {
	for (let intento = 0; intento < 5; intento++) {
		const cur = await env.DB.prepare('SELECT datos, version, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
		const actual = cur && !cur.borrado ? JSON.parse(cur.datos) : null;
		const nuevo = await mutar(actual);
		if (nuevo === undefined) return actual;
		if (nuevo === null) {
			if (!actual) return null;
			if (await escribir(env, { tipo, id }, cur, cur.datos, true, por)) return null;
			continue;
		}
		if (await escribir(env, { tipo, id }, cur, JSON.stringify(nuevo), false, por)) return nuevo;
	}
	throw new ErrorVisible(409, 'Varias personas lo cambiaron al mismo tiempo; vuelve a intentarlo');
}

// Error con un mensaje pensado para la persona (sale tal cual en la pantalla) y su código HTTP.
export class ErrorVisible extends Error {
	constructor(estado, mensaje) { super(mensaje); this.estado = estado; }
}
