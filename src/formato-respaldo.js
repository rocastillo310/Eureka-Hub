// Formato del respaldo de la base (F5) y cómo se restaura. Lo usan el Worker (respaldo diario) y los scripts
// `npm run respaldo` y `npm run restore`, así los tres hablan exactamente el mismo formato.
//
// Un respaldo es la tabla `entidades` completa (también lo borrado, para poder restaurar todo tal cual), el contador
// y la tabla `meta`. No lleva las subidas en curso (son temporales) ni los archivos de R2 (van aparte, en el manifiesto).

export const FORMATO = 'eureka-hub-respaldo';
export const COLUMNAS = ['tipo', 'id', 'datos', 'version', 'seq', 'creado', 'actualizado', 'borrado', 'por'];
// D1 no acepta sentencias SQL de más de 100 KB (Limits, consultado el 13 oct 2026); un registro sí puede llegar a
// 2 MB. Los textos largos (p. ej., un tablero de marca con imágenes) se restauran en pedazos.
const TROZO = 25_000;

export function armarRespaldo({ entidades, contador, meta, generado = new Date().toISOString(), origen = '' }) {
	return {
		formato: FORMATO, version: 1, generado, origen,
		contador: Number(contador) || 0,
		meta: (meta || []).filter((m) => !String(m.clave).startsWith('respaldo')),
		entidades: (entidades || []).map((e) => Object.fromEntries(COLUMNAS.map((c) => [c, e[c] ?? null]))),
	};
}

export function validarRespaldo(r) {
	if (!r || typeof r !== 'object' || r.formato !== FORMATO) return 'Ese archivo no es un respaldo de Eureka Hub';
	if (r.version !== 1) return `Versión de respaldo desconocida: ${r.version}`;
	if (!Array.isArray(r.entidades)) return 'El respaldo no trae entidades';
	for (const e of r.entidades) {
		if (typeof e.tipo !== 'string' || typeof e.id !== 'string' || typeof e.datos !== 'string') return 'El respaldo tiene una fila dañada';
		try { JSON.parse(e.datos); } catch { return `El respaldo tiene datos dañados en ${e.tipo}/${e.id}`; }
	}
	return null;
}

// Huella para comparar lo restaurado contra el respaldo: mismo tipo, id, datos y borrado, en cualquier orden.
export function huella(filas) {
	return filas.map((e) => `${e.tipo}|${e.id}|${e.borrado ? 1 : 0}|${e.datos}`).sort().join('\n');
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// SQL que deja la base igual al respaldo. En vez de vaciar la tabla, cada fila se escribe con un `seq` nuevo y lo que
// no estaba en el respaldo se marca como borrado: así las pantallas abiertas reciben todo en su siguiente sync.
// `actuales`: filas que hay hoy en la base ({tipo, id, version, borrado}); `contadorActual`: el seq de hoy.
export function sqlRestauracion(r, actuales, contadorActual) {
	const ahora = new Date().toISOString();
	let seq = Math.max(Number(contadorActual) || 0, r.contador || 0);
	const versiones = new Map(actuales.map((a) => [a.tipo + '|' + a.id, Number(a.version) || 0]));
	const enRespaldo = new Set();
	const sql = [];
	for (const e of r.entidades) {
		seq++;
		const k = e.tipo + '|' + e.id;
		enRespaldo.add(k);
		const v = Math.max(Number(e.version) || 1, (versiones.get(k) || 0) + 1);
		const datos = String(e.datos);
		sql.push(
			'INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) ' +
			`VALUES (${q(e.tipo)}, ${q(e.id)}, ${q(datos.slice(0, TROZO))}, ${v}, ${seq}, ${Number(e.creado) || seq}, ${q(ahora)}, ${e.borrado ? 1 : 0}, 'restauracion') ` +
			'ON CONFLICT (tipo, id) DO UPDATE SET datos = excluded.datos, version = excluded.version, seq = excluded.seq, creado = excluded.creado, ' +
			'actualizado = excluded.actualizado, borrado = excluded.borrado, por = excluded.por;',
		);
		for (let i = TROZO; i < datos.length; i += TROZO) {
			sql.push(`UPDATE entidades SET datos = datos || ${q(datos.slice(i, i + TROZO))} WHERE tipo = ${q(e.tipo)} AND id = ${q(e.id)};`);
		}
	}
	for (const a of actuales) {
		if (enRespaldo.has(a.tipo + '|' + a.id) || Number(a.borrado)) continue;
		seq++;
		sql.push(`UPDATE entidades SET borrado = 1, version = version + 1, seq = ${seq}, actualizado = ${q(ahora)}, por = 'restauracion' WHERE tipo = ${q(a.tipo)} AND id = ${q(a.id)};`);
	}
	for (const m of r.meta || []) sql.push(`INSERT INTO meta (clave, valor) VALUES (${q(m.clave)}, ${q(m.valor)}) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor;`);
	sql.push(`UPDATE contador SET seq = ${seq} WHERE id = 1;`);
	return sql.join('\n') + '\n';
}
