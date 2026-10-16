// Rutas /api del Centro Eureka Hub: yo, bootstrap, seed (solo desarrollo), sync (F1) y entregas/* (F2, en entregas.js).
// Cada elemento de la pantalla es una fila de `entidades`; los cambios se mezclan con merge3 para que
// dos personas editando lo mismo no se pisen. Los permisos se revisan AQUÍ, no solo en la pantalla.
import { merge3, sj } from './merge3.js';
import { verificarAccess } from './access.js';
import { correosDelEquipo, correosAdministracion, sincronizarPoliticaAccess } from './access-politica.js';
import { aEntidad, escribir, ErrorVisible, leerEntidad } from './entidades.js';
import { esDuenoPrivado, privadoConfigurado, entrar as entrarPrivado, llaveValida, leerEnlaces, guardarEnlaces } from './privado.js';
import { registrar, listar as listarBitacora, describirPersona, describirAjuste } from './bitacora.js';
import { manejarEntregas } from './entregas.js';
import { prepararContacto } from './contactos.js';
import { respaldar, estadoRespaldo } from './respaldo.js';
import { configurado as googleConfigurado, estadoGoogle, urlConectar, completarConexion, desconectar, sincronizarActividad, sincronizarProximas } from './calendario.js';

export const TIPOS = new Set(['user', 'account', 'list', 'task', 'cal', 'ag', 'auto', 'inbox', 'note', 'cols', 'stat', 'seen', 'pref', 'board', 'entrega', 'actividad', 'ajuste', 'contacto']);
// Niveles: Administración (Rodrigo y Dani) > Dirección (rol admin) > Equipo.
// Solo Administración cambia el equipo y los permisos (`user`) y las reglas (`ajuste`); Dirección, la operación
// (automatizaciones, estados y columnas de la pizarra).
export const SOLO_ADMINISTRACION = new Set(['user', 'ajuste']);
export const SOLO_ADMIN = new Set(['auto', 'stat', 'cols']);
export const esAdministracion = (u) => !!u && u.nivel === 'administracion' && !u.baja;
export const esDuenoRespaldo = (env, u) => !!u && !u.baja && !!(env.RESPALDO_DUENO || '').trim() && u.id === env.RESPALDO_DUENO.trim();
const SOLO_ADM_MSG = 'Solo Administración (panel de administración) puede hacer esto';
// `entrega` la escribe solo el servidor (rutas /api/entregas/*), que estampa autor y hora; por sync se rechaza.
// `actividad` solo se añade: la pantalla puede crear la de tareas y juntas, pero el servidor pone `por` y `t`.
export const SOLO_SERVIDOR = new Set(['entrega']);
const OBJETOS_ACTIVIDAD = new Set(['task', 'junta']);
const texto = (x, max) => String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Limpia una actividad que manda la pantalla. Devuelve los datos a guardar o el motivo del rechazo.
export function actividadDeCliente(c, usuario) {
	const d = c.datos;
	if (!d || c.base) return { motivo: 'La actividad no se edita ni se borra' };
	const o = d.objeto;
	if (!o || typeof o !== 'object' || !OBJETOS_ACTIVIDAD.has(o.tipo) || typeof o.id !== 'string') return { motivo: 'Actividad inválida' };
	const verbo = texto(d.verbo, 60);
	if (!verbo) return { motivo: 'Actividad inválida' };
	const datos = { id: c.id, t: new Date().toISOString(), por: usuario.id, verbo, objeto: { tipo: o.tipo, id: texto(o.id, 80), titulo: texto(o.titulo, 200) } };
	if (typeof d.cuentaId === 'string' && d.cuentaId) datos.cuentaId = texto(d.cuentaId, 80);
	if (d.detalle) datos.detalle = texto(d.detalle, 500);
	return { datos };
}

const MAX_CAMBIOS = 300;
const MAX_ENTIDAD = 1_500_000; // caracteres de JSON por elemento; el cliente ya rechaza `board` de más de ~1.4 M
const LIMITE_RESPUESTA = 3000;
const CAB = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '[::1]']);

const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });
const error = (estado, mensaje) => resp({ error: mensaje }, estado);

async function leerJson(request, maximo = 6_000_000) {
	const texto = await request.text();
	if (texto.length > maximo) throw new ErrorVisible(413, 'La solicitud es demasiado grande');
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
const BAJA = 'Tu acceso al Hub fue dado de baja. Si es un error, habla con Dirección.';
async function quien(request, env) {
	if (esModoDev(request, env)) {
		// En desarrollo, <video> e <img> no pueden mandar encabezados: se acepta también ?devUser= (solo aquí).
		const id = request.headers.get('X-Dev-User') || new URL(request.url).searchParams.get('devUser');
		const u = id ? (await usuarios(env)).find((x) => x.id === id) : null;
		if (u && u.baja) return { dev: true, usuario: null, email: null, motivo: BAJA };
		return { dev: true, usuario: u || null, email: null, motivo: u ? null : 'Elige un usuario' };
	}
	const v = await verificarAccess(request, env);
	if (!v.ok) return { dev: false, usuario: null, email: null, motivo: v.motivo };
	const correo = v.email.toLowerCase();
	const u = (await usuarios(env)).find((x) => typeof x.email === 'string' && x.email.toLowerCase() === correo);
	if (u && u.baja) return { dev: false, usuario: null, email: v.email, motivo: BAJA };
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

async function hayDatos(env) {
	const m = await env.DB.prepare("SELECT 1 AS x FROM meta WHERE clave = 'semillado'").first();
	if (m) return true;
	return !!(await env.DB.prepare('SELECT 1 AS x FROM entidades LIMIT 1').first());
}

// ---------- escritura ----------
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
		if (texto.length > MAX_ENTIDAD) throw new ErrorVisible(413, 'Es demasiado grande para guardarse (máximo 1.5 MB por elemento)');
		if (await escribir(env, c, cur, texto, false, por)) return;
	}
	throw new ErrorVisible(409, 'Varias personas lo cambiaron al mismo tiempo; vuelve a intentarlo');
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
	if (SOLO_SERVIDOR.has(c.tipo)) return 'Esto lo registra solo el servidor';
	if (SOLO_ADMINISTRACION.has(c.tipo) && !esAdministracion(usuario)) return SOLO_ADM_MSG;
	if (SOLO_ADMIN.has(c.tipo) && usuario.role !== 'admin' && !esAdministracion(usuario)) return 'Solo Dirección puede cambiar esto';
	return null;
}

// Cambios al equipo (dar de baja, cambiar rol, quitar a alguien): nadie se da de baja a sí mismo y siempre queda al
// menos una persona de Dirección activa; si no, nadie podría administrar el Hub.
export async function motivoNoCambiarEquipo(env, c, usuario) {
	if (c.datos && c.datos.baja && c.id === usuario.id) return 'No puedes darte de baja a ti mismo';
	// Nadie se quita su propio nivel de Administración (evita perder el acceso por un clic): lo hace la otra persona.
	if (c.id === usuario.id && esAdministracion(usuario) && (!c.datos || c.datos.nivel !== 'administracion')) return 'No puedes quitarte tu propio nivel de Administración; pídeselo a otra persona de Administración';
	const despues = (await usuarios(env)).filter((u) => u.id !== c.id);
	if (c.datos) despues.push({ ...c.datos, id: c.id });
	if (!despues.some((u) => u.nivel === 'administracion' && !u.baja)) return 'Debe quedar al menos una persona de Administración activa';
	return null;
}

// Eliminar una cuenta: solo Dirección, y solo si nada depende de ella (tareas, calendarios, entregas, contactos).
// Sus listas vacías y su tablero se borran en el mismo cambio desde la pantalla.
export async function motivoNoBorrarCuenta(env, id, usuario) {
	if (!esAdministracion(usuario)) return 'Solo Administración puede eliminar cuentas';
	const r = await env.DB.prepare(
		"SELECT tipo, COUNT(*) AS n FROM entidades WHERE borrado = 0 AND ((tipo IN ('task', 'cal') AND json_extract(datos, '$.acc') = ?1) " +
		"OR (tipo IN ('entrega', 'contacto') AND json_extract(datos, '$.cuentaId') = ?1)) GROUP BY tipo",
	).bind(id).all();
	const NOMBRES = { task: 'tareas', cal: 'calendarios', entrega: 'entregas', contacto: 'contactos' };
	const hay = (r.results || []).filter((x) => x.n > 0).map((x) => `${x.n} ${NOMBRES[x.tipo]}`);
	return hay.length ? `La cuenta todavía tiene ${hay.join(', ')}` : null;
}

// Lo que el servidor tiene hoy de un elemento, para que la pantalla deshaga un cambio rechazado.
async function estadoActual(env, tipo, id) {
	const f = await env.DB.prepare('SELECT tipo, id, datos, version, seq, creado, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
	return f ? aEntidad(f) : { tipo, id, datos: null, borrado: true };
}

// Deja en el historial un cambio sensible ya guardado (permisos, reglas, cuenta eliminada).
async function anotarCambio(env, por, c, antes) {
	const despues = await leerEntidad(env, c.tipo, c.id);
	const a = antes && !antes.borrado ? antes.datos : null, d = despues && !despues.borrado ? despues.datos : null;
	let e = null;
	if (c.tipo === 'user') e = describirPersona(a, d);
	else if (c.tipo === 'ajuste') e = describirAjuste(c.id, a, d);
	else if (c.tipo === 'account' && a && !d) e = { accion: 'Cuenta eliminada', detalle: a.name || c.id };
	if (e) await registrar(env, por, e.accion, e.detalle);
}

// Trabajo que sigue después de responder (si no hay ctx, como en las pruebas, se espera).
function enSegundoPlano(ctx, promesa) {
	const p = promesa.catch((e) => console.error('segundo plano', e));
	if (ctx && ctx.waitUntil) ctx.waitUntil(p);
	return p;
}

// ---------- rutas ----------
export async function manejarApi(request, env, ctx) {
	const url = new URL(request.url);
	const ruta = url.pathname.replace(/^\/api\/?/, '');
	const metodo = request.method;
	try {
		if (!env.DB) return error(500, 'Falta la base de datos (binding DB)');
		if (ruta === 'salud' && metodo === 'GET') return resp({ ok: true });

		const q = await quien(request, env);

		if (ruta === 'yo' && metodo === 'GET') {
			return resp({ dev: q.dev, yo: q.usuario ? q.usuario.id : null, aviso: q.usuario ? null : q.motivo || null, ...(esDuenoRespaldo(env, q.usuario) ? { respaldo: true } : {}), ...(esDuenoPrivado(env, q.usuario) ? { privado: true } : {}) });
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
			let cambioEquipo = false;
			const actividades = [];
			for (const c of cambios) {
				const motivo = permiso(q.usuario, c);
				if (motivo) { rechazados.push({ tipo: c.tipo, id: c.id, motivo }); continue; }
				if (c.tipo === 'user' && c.datos && typeof c.datos.email === 'string') c.datos.email = c.datos.email.trim().toLowerCase();
				if (c.tipo === 'actividad') {
					const ya = await env.DB.prepare("SELECT 1 AS x FROM entidades WHERE tipo = 'actividad' AND id = ?1").bind(c.id).first();
					const a = ya ? { motivo: 'La actividad no se edita ni se borra' } : actividadDeCliente(c, q.usuario);
					if (a.motivo) { rechazados.push({ tipo: c.tipo, id: c.id, motivo: a.motivo }); continue; }
					c.datos = a.datos;
				}
				if (c.tipo === 'list' && c.datos === null && q.usuario.role !== 'admin') {
					rechazados.push({ tipo: c.tipo, id: c.id, motivo: 'Solo Dirección puede eliminar listas' });
					continue;
				}
				if (c.tipo === 'user') {
					const m = await motivoNoCambiarEquipo(env, c, q.usuario);
					if (m) { rechazados.push({ tipo: c.tipo, id: c.id, motivo: m }); continue; }
				}
				if (c.tipo === 'account' && c.datos === null) {
					const m = await motivoNoBorrarCuenta(env, c.id, q.usuario);
					if (m) { rechazados.push({ tipo: c.tipo, id: c.id, motivo: m }); continue; }
				}
				if (c.tipo === 'contacto') {
					const k = await prepararContacto(env, c, q.usuario);
					if (k.motivo) { rechazados.push({ tipo: c.tipo, id: c.id, motivo: k.motivo }); continue; }
					c.datos = k.datos;
				}
				// Un cambio que no se puede guardar se rechaza solo: si tronara toda la solicitud, la pantalla lo reintentaría
				// para siempre y nada de lo demás se guardaría.
				const sensible = c.tipo === 'user' || c.tipo === 'ajuste' || (c.tipo === 'account' && c.datos === null);
				const antes = sensible ? await leerEntidad(env, c.tipo, c.id) : null;
				try {
					await aplicarCambio(env, c, q.usuario.id);
				} catch (err) {
					if (!(err instanceof ErrorVisible)) console.error('sync', c.tipo, c.id, err);
					rechazados.push({ tipo: c.tipo, id: c.id, motivo: err instanceof ErrorVisible ? err.message : 'Error del servidor al guardarlo' });
					continue;
				}
				if (c.tipo === 'user') cambioEquipo = true;
				if (c.tipo === 'ag') actividades.push(c.id);
				if (sensible) await anotarCambio(env, q.usuario.id, c, antes);
			}
			// Reuniones del equipo con enlace: invitación de Google Calendar (después de responder, sin hacer esperar).
			if (actividades.length) enSegundoPlano(ctx, Promise.all(actividades.map((id) => sincronizarActividad(env, id))));
			// Si cambió el equipo, la lista de correos de Cloudflare Access se pone igual a la de la base.
			let aviso;
			if (cambioEquipo) {
				// El panel /admin tiene su propia política de Access: solo los correos de Administración.
				if ((env.ACCESS_POLITICA_ADMIN_ID || '').trim()) {
					const ra = await sincronizarPoliticaAccess({ ...env, ACCESS_POLITICA_ID: env.ACCESS_POLITICA_ADMIN_ID }, await correosAdministracion(env));
					if (!ra.ok) aviso = `Se guardó, pero el acceso al panel de administración en Cloudflare no se actualizó: ${ra.motivo}.`;
				}
				const r = await sincronizarPoliticaAccess(env, await correosDelEquipo(env));
				if (!r.ok) aviso = `Se guardó en el equipo, pero Cloudflare Access no se actualizó: ${r.motivo}. Corrige la lista de correos de la política a mano en el dashboard.`;
			}
			const { entidades, cursor, mas } = await cambiosDesde(env, desde);
			// Lo rechazado vuelve con su estado del servidor para que la pantalla deshaga el cambio local.
			for (const r of rechazados) {
				if (!entidades.some((e) => e.tipo === r.tipo && e.id === r.id)) entidades.push(await estadoActual(env, r.tipo, r.id));
			}
			return resp({ entidades, cursor, mas, ...(rechazados.length ? { rechazados } : {}), ...(aviso ? { aviso } : {}) });
		}

		// Panel privado: solo la persona de PRIVADO_DUENO, con contraseña (src/privado.js). No va al historial del panel.
		if (ruta.startsWith('privado/')) {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			if (!esDuenoPrivado(env, q.usuario)) return error(403, 'Este panel es privado');
			if (!privadoConfigurado(env)) return error(409, 'Falta configurar la contraseña del panel privado (secreto PRIVADO_CLAVE)');
			if (ruta === 'privado/entrar' && metodo === 'POST') {
				const r = await entrarPrivado(env, q.usuario, (await leerJson(request, 2000)).clave);
				return r.ok ? resp({ llave: r.llave, vence: r.vence }) : error(r.estado, r.motivo);
			}
			if (!(await llaveValida(env, q.usuario, request.headers.get('X-Privado')))) return error(401, 'Vuelve a escribir la contraseña del panel privado');
			if (ruta === 'privado/enlaces' && metodo === 'GET') return resp({ enlaces: await leerEnlaces(env) });
			if (ruta === 'privado/enlaces' && metodo === 'POST') {
				const r = await guardarEnlaces(env, (await leerJson(request, 200_000)).enlaces);
				return r.motivo ? error(400, r.motivo) : resp(r);
			}
		}

		// Historial del panel de administración.
		if (ruta === 'admin/bitacora' && metodo === 'GET') {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			if (!esAdministracion(q.usuario)) return error(403, SOLO_ADM_MSG);
			return resp({ bitacora: await listarBitacora(env) });
		}

		// Respaldo (F5): solo la persona dueña del respaldo (RESPALDO_DUENO, variable del Worker; hoy, Rodrigo) ve su
		// estado y lanza uno a mano. Se decide en Cloudflare, no en el panel, para que nadie se dé ese permiso.
		if (ruta === 'respaldo/estado' || ruta === 'respaldo/ahora') {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			if (!esDuenoRespaldo(env, q.usuario)) return error(403, 'Solo la persona dueña del respaldo puede ver esto');
			if (ruta === 'respaldo/estado' && metodo === 'GET') return resp({ repo: (env.RESPALDO_REPO || '').trim() || null, configurado: !!(env.RESPALDO_REPO && env.GITHUB_TOKEN_RESPALDO), ultimo: await estadoRespaldo(env) });
			if (ruta === 'respaldo/ahora' && metodo === 'POST') return resp(await respaldar(env, { origen: 'manual' }));
		}

		// Google Calendar: solo Administración conecta o desconecta la cuenta que manda las invitaciones.
		if (ruta.startsWith('google/')) {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			if (!esAdministracion(q.usuario)) return error(403, SOLO_ADM_MSG);
			const origen = url.origin;
			if (ruta === 'google/estado' && metodo === 'GET') return resp(await estadoGoogle(env));
			if (!googleConfigurado(env)) return error(409, 'Falta configurar Google (secretos GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)');
			if (ruta === 'google/conectar' && metodo === 'GET') return Response.redirect(await urlConectar(env, origen), 302);
			if (ruta === 'google/callback' && metodo === 'GET') {
				const r = await completarConexion(env, origen, url.searchParams.get('code'), url.searchParams.get('state'));
				if (r.ok) enSegundoPlano(ctx, sincronizarProximas(env));
				await registrar(env, q.usuario.id, 'Google Calendar', r.ok ? 'conectado' : `no se conectó: ${r.motivo}`);
				return Response.redirect(`${origen}/admin?google=${r.ok ? 'ok' : 'error&motivo=' + encodeURIComponent(r.motivo)}`, 302);
			}
			if (ruta === 'google/desconectar' && metodo === 'POST') { await desconectar(env); await registrar(env, q.usuario.id, 'Google Calendar', 'desconectado'); return resp({ ok: true }); }
		}

		if (ruta.startsWith('entregas/')) {
			if (!q.usuario) return error(401, q.motivo || 'No autenticado');
			return await manejarEntregas(request, env, ruta.slice('entregas/'.length), q.usuario);
		}

		return error(404, 'Ruta no encontrada');
	} catch (e) {
		if (e instanceof ErrorVisible) return error(e.estado, e.message);
		if (e instanceof SyntaxError) return error(400, 'La solicitud no es JSON válido');
		// Lo inesperado queda en los registros del Worker (`npx wrangler tail`); a la persona no se le muestran detalles internos.
		console.error('api', metodo, ruta, e);
		return error(500, 'Error del servidor. Si se repite, avisa a Dirección.');
	}
}
