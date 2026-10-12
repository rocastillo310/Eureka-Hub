// Rutas /api del Centro Eureka Hub (F1): yo, bootstrap, seed (solo desarrollo) y sync.
// Cada elemento de la pantalla es una fila de `entidades`; los cambios se mezclan con merge3 para que
// dos personas editando lo mismo no se pisen. Los permisos se revisan AQUÍ, no solo en la pantalla.
import { merge3, sj } from './merge3.js';
import { verificarAccess } from './access.js';

export const TIPOS = new Set(['user', 'account', 'list', 'task', 'cal', 'ag', 'auto', 'inbox', 'note', 'cols', 'stat', 'seen', 'pref', 'board']);
// Solo el rol admin escribe estos tipos (sección 5 del prompt).
export const SOLO_ADMIN = new Set(['user', 'auto', 'stat', 'cols']);

const MAX_CAMBIOS = 300;
const MAX_ENTIDAD = 1_500_000; // caracteres de JSON por elemento; el cliente ya rechaza `board` de más de ~1.4 M
const LIMITE_RESPUESTA = 3000;
const CAB = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '[::1]']);

const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });
const error = (estado, mensaje) => resp({ error: mensaje }, estado);

async function leerJson(request, maximo = 6_000_000) {
	const texto = await request.text();
	if (texto.length > maximo) throw new Error('demasiado grande');
	return JSON.parse(texto);
}

// El modo desarrollo (encabezado X-Dev-User) exige DOS cosas a la vez: la variable DEV_LOGIN=1, que solo existe en
// .dev.vars (fuera del repositorio y nunca desplegada), y que la petición llegue a localhost. En producción la
// petición llega a *.workers.dev, así que aunque alguien configurara DEV_LOGIN, este camino sigue cerrado.
export function esModoDev(request, env) {
	if (env.DEV_LOGIN !== '1') return false;
	return HOSTS_LOCALES.has(new URL(request.url).hostname);
}

async function usuarios(env) {
	const r = await env.DB.prepare("SELECT id, datos FROM entidades WHERE tipo = 'user' AND borrado = 0").all();
	return (r.results || []).map((f) => ({ ...JSON.parse(f.datos), id: f.id }));
}

// ---------- identidad ----------
async function quien(request, env) {
	if (esModoDev(request, env)) {
		const id = request.headers.get('X-Dev-User');
		const u = id ? (await usuarios(env)).find((x) => x.id === id) : null;
		return { dev: true, usuario: u || null, email: null, motivo: u ? null : 'Elige un usuario' };
	}
	const v = await verificarAccess(request, env);
	if (!v.ok) return { dev: false, usuario: null, email: null, motivo: v.motivo };
	const correo = v.email.toLowerCase();
	const u = (await usuarios(env)).find((x) => typeof x.email === 'string' && x.email.toLowerCase() === correo);
	return { dev: false, usuario: u || null, email: v.email, motivo: u ? null : 'Ese correo no está dado de alta en el equipo' };
}

// ---------- lectura ----------
async function cambiosDesde(env, desde) {
	const filtro = desde > 0 ? '' : 'AND borrado = 0';
	const r = await env.DB.prepare(
		`SELECT tipo, id, datos, version, seq, creado, borrado FROM entidades WHERE seq > ?1 ${filtro} ORDER BY seq ASC LIMIT ?2`,
	).bind(desde, LIMITE_RESPUESTA + 1).all();
	const filas = r.results || [];
	const mas = filas.length > LIMITE_RESPUESTA;
	const entidades = filas.slice(0, LIMITE_RESPUESTA).map(aEntidad);
	const cursor = entidades.length ? entidades[entidades.length - 1].seq : desde;
	return { entidades, cursor, mas };
}

const aEntidad = (f) => ({
	tipo: f.tipo, id: f.id, datos: f.borrado ? null : JSON.parse(f.datos), version: f.version, seq: f.seq, creado: f.creado, borrado: !!f.borrado,
});

async function hayDatos(env) {
	const m = await env.DB.prepare("SELECT 1 AS x FROM meta WHERE clave = 'semillado'").first();
	if (m) return true;
	return !!(await env.DB.prepare('SELECT 1 AS x FROM entidades LIMIT 1').first());
}

// ---------- escritura ----------
async function escribir(env, c, cur, datosTexto, borrado, por) {
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

async function aplicarCambio(env, c, por) {
	for (let intento = 0; intento < 5; intento++) {
		const cur = await env.DB.prepare('SELECT datos, version, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(c.tipo, c.id).first();
		if (c.datos === null) {
			if (!cur || cur.borrado) return;
			if (await escribir(env, c, cur, cur.datos, true, por)) return;
			continue;
		}
		if (cur && cur.borrado && c.base) return; // alguien lo borró mientras esta persona lo editaba: gana el borrado
		const existe = cur && !cur.borrado;
		const nuevo = existe ? merge3(c.base, c.datos, JSON.parse(cur.datos)) : c.datos;
		if (existe && sj(nuevo) === sj(JSON.parse(cur.datos))) return; // nada que cambiar
		const texto = JSON.stringify(nuevo);
		if (texto.length > MAX_ENTIDAD) throw new Error('elemento demasiado grande');
		if (await escribir(env, c, cur, texto, false, por)) return;
	}
	throw new Error('no se pudo guardar por cambios simultáneos');
}

function validarCambio(c) {
	if (!c || typeof c !== 'object') return 'cambio inválido';
	if (!TIPOS.has(c.tipo)) return 'tipo desconocido: ' + c.tipo;
	if (typeof c.id !== 'string' || !c.id || c.id.length > 80) return 'id inválido';
	if (c.datos !== null && (typeof c.datos !== 'object' || Array.isArray(c.datos))) return 'datos inválidos';
	if (c.base !== null && c.base !== undefined && (typeof c.base !== 'object' || Array.isArray(c.base))) return 'base inválida';
	return null;
}

// Permisos por cambio. Devuelve null si se permite, o el motivo del rechazo.
export function permiso(usuario, c) {
	if (SOLO_ADMIN.has(c.tipo) && usuario.role !== 'admin') return 'Solo Dirección puede cambiar esto';
	return null;
}

// Lo que el servidor tiene hoy de un elemento, para que la pantalla deshaga un cambio rechazado.
async function estadoActual(env, tipo, id) {
	const f = await env.DB.prepare('SELECT tipo, id, datos, version, seq, creado, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
	return f ? aEntidad(f) : { tipo, id, datos: null, borrado: true };
}

// ---------- rutas ----------
export async function manejarApi(request, env) {
	const url = new URL(request.url);
	const ruta = url.pathname.replace(/^\/api\/?/, '');
	const metodo = request.method;
	try {
		if (!env.DB) return error(500, 'Falta la base de datos (binding DB)');
		if (ruta === 'salud' && metodo === 'GET') return resp({ ok: true });

		const q = await quien(request, env);

		if (ruta === 'yo' && metodo === 'GET') {
			return resp({ dev: q.dev, yo: q.usuario ? q.usuario.id : null, aviso: q.usuario ? null : q.motivo || null });
		}

		if (ruta === 'seed' && metodo === 'POST') {
			// Deshabilitado en producción: solo modo desarrollo y con PERMITIR_SEMILLA=1 en .dev.vars.
			if (!q.dev || env.PERMITIR_SEMILLA !== '1') return error(403, 'La semilla solo se carga en desarrollo');
			if (await hayDatos(env)) return resp({ ya: true }, 409);
			const cuerpo = await leerJson(request);
			const lista = Array.isArray(cuerpo.entidades) ? cuerpo.entidades : [];
			for (const e of lista) {
				const m = validarCambio({ ...e, base: null });
				if (m || e.datos === null) return error(400, m || 'datos inválidos');
			}
			for (const e of lista) await aplicarCambio(env, { ...e, base: null }, 'semilla');
			await env.DB.prepare("INSERT OR IGNORE INTO meta (clave, valor) VALUES ('semillado', '1')").run();
			return resp({ ok: true, total: lista.length });
		}

		// En desarrollo, bootstrap se permite sin usuario para que la pantalla muestre el selector.
		if (ruta === 'bootstrap' && metodo === 'GET') {
			if (!q.usuario && !q.dev) return error(401, q.motivo || 'No autenticado');
			const { entidades, cursor, mas } = await cambiosDesde(env, 0);
			// En producción nunca se devuelve vacio:true: el equipo viene precargado con `npm run seed:equipo`.
			const vacio = q.dev ? !(await hayDatos(env)) : false;
			return resp({ ...(vacio ? { vacio } : {}), entidades, cursor, mas });
		}

		if (ruta === 'sync' && metodo === 'POST') {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			const cuerpo = await leerJson(request);
			const desde = Number.isFinite(cuerpo.desde) ? cuerpo.desde : 0;
			const cambios = Array.isArray(cuerpo.cambios) ? cuerpo.cambios : [];
			if (cambios.length > MAX_CAMBIOS) return error(413, 'Demasiados cambios en una sola solicitud');
			for (const c of cambios) { const m = validarCambio(c); if (m) return error(400, m); }
			const rechazados = [];
			for (const c of cambios) {
				const motivo = permiso(q.usuario, c);
				if (motivo) { rechazados.push({ tipo: c.tipo, id: c.id, motivo }); continue; }
				await aplicarCambio(env, c, q.usuario.id);
			}
			const { entidades, cursor, mas } = await cambiosDesde(env, desde);
			// Lo rechazado vuelve con su estado del servidor para que la pantalla deshaga el cambio local.
			for (const r of rechazados) {
				if (!entidades.some((e) => e.tipo === r.tipo && e.id === r.id)) entidades.push(await estadoActual(env, r.tipo, r.id));
			}
			return resp({ entidades, cursor, mas, ...(rechazados.length ? { rechazados } : {}) });
		}

		return error(404, 'Ruta no encontrada');
	} catch (e) {
		return error(e instanceof SyntaxError ? 400 : 500, e.message || 'Error del servidor');
	}
}
