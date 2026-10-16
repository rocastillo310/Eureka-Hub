// Invitaciones de Google Calendar para las reuniones del equipo.
// Cuando una actividad de la Agenda es «Para todo el equipo» y tiene enlace (Google Meet u otro), el Worker crea el
// evento en el Google Calendar de quien conectó su cuenta (Dirección) e invita a cada persona activa del equipo:
// Google les manda el correo de invitación y se lo pone en su calendario. Si cambia la fecha, la hora, el título o el
// enlace, se actualiza la invitación; si se borra la actividad o se quita el enlace, se cancela.
//
// Secretos del Worker: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (cliente OAuth de Google Cloud, tipo «Aplicación web»).
// La llave para usar el calendario (refresh token) la guarda el propio Worker en la tabla `meta` al conectar desde
// Ajustes; las claves `google…` de `meta` nunca entran al respaldo (ver formato-respaldo.js).
import { leerEntidad } from './entidades.js';

export const ALCANCE = 'https://www.googleapis.com/auth/calendar.events';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const ZONA = 'America/Mexico_City';
const DURACION_MIN = 60;
const URL_OK = /^https?:\/\/[^\s"'<>/]+\.[^\s"'<>]+/i;

export const configurado = (env) => !!((env.GOOGLE_CLIENT_ID || '').trim() && (env.GOOGLE_CLIENT_SECRET || '').trim());
export const redirigirA = (origen) => origen + '/api/google/callback';

// ---------- meta ----------
async function leerMeta(env, clave) {
	const f = await env.DB.prepare('SELECT valor FROM meta WHERE clave = ?1').bind(clave).first();
	return f ? f.valor : null;
}
async function ponerMeta(env, clave, valor) {
	await env.DB.prepare('INSERT INTO meta (clave, valor) VALUES (?1, ?2) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor').bind(clave, valor).run();
}
async function quitarMeta(env, clave) {
	await env.DB.prepare('DELETE FROM meta WHERE clave = ?1').bind(clave).run();
}
async function anotar(env, resultado) {
	await ponerMeta(env, 'google_ultimo', JSON.stringify({ ...resultado, en: new Date().toISOString() }));
}

export async function estadoGoogle(env) {
	const cuenta = await leerMeta(env, 'google_cuenta');
	const ultimo = await leerMeta(env, 'google_ultimo');
	return { configurado: configurado(env), conectado: !!(await leerMeta(env, 'google_token')), cuenta: cuenta || null, ultimo: ultimo ? JSON.parse(ultimo) : null };
}

// ---------- conectar (OAuth) ----------
export async function urlConectar(env, origen) {
	const estado = crypto.randomUUID();
	await ponerMeta(env, 'google_estado', JSON.stringify({ s: estado, t: Date.now() }));
	const q = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID.trim(), redirect_uri: redirigirA(origen), response_type: 'code', scope: ALCANCE,
		access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: estado,
	});
	return `${AUTH}?${q}`;
}

export async function completarConexion(env, origen, codigo, estado, buscar = fetch) {
	const guardado = JSON.parse((await leerMeta(env, 'google_estado')) || 'null');
	await quitarMeta(env, 'google_estado');
	if (!guardado || !estado || guardado.s !== estado || Date.now() - guardado.t > 15 * 60_000) return { ok: false, motivo: 'La conexión expiró o no coincide; vuelve a intentarlo desde Ajustes' };
	if (!codigo) return { ok: false, motivo: 'Google no autorizó la conexión' };
	const r = await buscar(TOKEN, {
		method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ code: codigo, client_id: env.GOOGLE_CLIENT_ID.trim(), client_secret: env.GOOGLE_CLIENT_SECRET.trim(), redirect_uri: redirigirA(origen), grant_type: 'authorization_code' }),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok || !j.refresh_token) return { ok: false, motivo: `Google no entregó la llave (${j.error || 'HTTP ' + r.status})` };
	await ponerMeta(env, 'google_token', j.refresh_token);
	cache = { token: j.access_token, vence: Date.now() + (Number(j.expires_in) || 0) * 1000 - 60_000 };
	const c = await buscar(CAL, { headers: { authorization: `Bearer ${j.access_token}` } });
	const cj = await c.json().catch(() => ({}));
	if (cj.id) await ponerMeta(env, 'google_cuenta', cj.id);
	return { ok: true };
}

export async function desconectar(env, buscar = fetch) {
	const t = await leerMeta(env, 'google_token');
	if (t) await buscar('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t }) }).catch(() => {});
	for (const k of ['google_token', 'google_cuenta', 'google_ultimo']) await quitarMeta(env, k);
	cache = null;
}

let cache = null;
async function tokenDeAcceso(env, buscar) {
	if (cache && cache.vence > Date.now()) return cache.token;
	const refresco = await leerMeta(env, 'google_token');
	if (!refresco) return null;
	const r = await buscar(TOKEN, {
		method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID.trim(), client_secret: env.GOOGLE_CLIENT_SECRET.trim(), refresh_token: refresco, grant_type: 'refresh_token' }),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok || !j.access_token) throw new Error(j.error === 'invalid_grant' ? 'Google retiró el permiso; vuelve a conectar Google Calendar en Ajustes' : `No se pudo renovar el permiso de Google (${j.error || 'HTTP ' + r.status})`);
	cache = { token: j.access_token, vence: Date.now() + (Number(j.expires_in) || 0) * 1000 - 60_000 };
	return cache.token;
}
export const _reiniciarCache = () => { cache = null; };

// ---------- actividad -> evento ----------
// Google acepta ids propios con letras a-v y dígitos; el id de la actividad en hexadecimal cumple.
export const eventoId = (agId) => 'eh' + [...new TextEncoder().encode(agId)].map((b) => b.toString(16).padStart(2, '0')).join('');

function sumarMinutos(fecha, hora, min) {
	const [a, m, d] = fecha.split('-').map(Number), [h, mi] = hora.split(':').map(Number);
	const t = new Date(Date.UTC(a, m - 1, d, h, mi + min));
	const p = (n) => String(n).padStart(2, '0');
	return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}

export function aEvento(ag, correos, cuenta) {
	const link = String(ag.link || '').trim();
	const conHora = /^\d{2}:\d{2}$/.test(ag.time || '');
	const lineas = [`Reunión del equipo agendada en Eureka Hub${cuenta ? ` (cuenta: ${cuenta})` : ''}.`, '', `Entrar: ${link}`];
	if (ag.notes) lineas.push('', String(ag.notes).slice(0, 2000));
	return {
		summary: String(ag.title || 'Reunión del equipo').slice(0, 200),
		description: lineas.join('\n'),
		location: link,
		start: conHora ? { dateTime: `${ag.date}T${ag.time}:00`, timeZone: ZONA } : { date: ag.date },
		end: conHora ? { dateTime: sumarMinutos(ag.date, ag.time, DURACION_MIN), timeZone: ZONA } : { date: sumarMinutos(ag.date, '00:00', 24 * 60).slice(0, 10) },
		attendees: correos.map((email) => ({ email })),
		reminders: { useDefault: true },
		status: 'confirmed',
	};
}

const quiereInvitacion = (ag) => !!ag && ag.owner === 'todos' && URL_OK.test(String(ag.link || '')) && /^\d{4}-\d{2}-\d{2}$/.test(ag.date || '');

async function correosActivos(env) {
	const r = await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'user' AND borrado = 0").all();
	return [...new Set((r.results || []).map((f) => JSON.parse(f.datos)).filter((u) => !u.baja && typeof u.email === 'string' && u.email.includes('@')).map((u) => u.email.trim().toLowerCase()))].sort();
}

// Deja el evento de Google igual a la actividad (o lo cancela). Solo escribe si cambió algo que importa a los
// invitados, para no mandarles un correo cada vez que alguien edita las notas.
export async function sincronizarActividad(env, agId, buscar = fetch) {
	if (!configurado(env) || !(await leerMeta(env, 'google_token'))) return { omitido: true };
	const clave = 'google_ev_' + agId;
	const previa = await leerMeta(env, clave);
	const e = await leerEntidad(env, 'ag', agId);
	const ag = e && !e.borrado ? e.datos : null;
	const url = `${CAL}/events/${eventoId(agId)}?sendUpdates=all`;
	if (!quiereInvitacion(ag) && !previa) return { omitido: true }; // nada que mandar ni que cancelar
	try {
		const token = await tokenDeAcceso(env, buscar);
		const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
		if (!quiereInvitacion(ag)) {
			const r = await buscar(url, { method: 'DELETE', headers: auth });
			if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Google no canceló la invitación (HTTP ${r.status})`);
			await quitarMeta(env, clave);
			await anotar(env, { ok: true, accion: 'cancelada', titulo: (ag && ag.title) || '' });
			return { ok: true, accion: 'cancelada' };
		}
		let cuenta = '';
		if (ag.acc) { const a = await leerEntidad(env, 'account', ag.acc); cuenta = (a && a.datos && a.datos.name) || ''; }
		const evento = aEvento(ag, await correosActivos(env), cuenta);
		const firma = JSON.stringify(evento);
		if (firma === previa) return { ok: true, accion: 'sin cambios' };
		// Primero se intenta actualizar (también revive un evento cancelado); si no existe, se crea con el mismo id.
		let r = await buscar(url, { method: 'PUT', headers: auth, body: JSON.stringify(evento) });
		if (r.status === 404) r = await buscar(`${CAL}/events?sendUpdates=all`, { method: 'POST', headers: auth, body: JSON.stringify({ id: eventoId(agId), ...evento }) });
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(`Google no guardó la invitación (HTTP ${r.status}${j.error && j.error.message ? ': ' + j.error.message : ''})`);
		}
		await ponerMeta(env, clave, firma);
		const accion = previa ? 'actualizada' : 'enviada';
		await anotar(env, { ok: true, accion, titulo: evento.summary, invitados: evento.attendees.length });
		return { ok: true, accion };
	} catch (err) {
		console.error('google calendar', agId, err);
		await anotar(env, { ok: false, motivo: err.message, titulo: (ag && ag.title) || '' });
		return { ok: false, motivo: err.message };
	}
}

// Al conectar: manda la invitación de las reuniones del equipo que aún no pasan.
export async function sincronizarProximas(env, buscar = fetch, hoy = new Date()) {
	const dia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(hoy);
	const r = await env.DB.prepare(
		"SELECT id FROM entidades WHERE tipo = 'ag' AND borrado = 0 AND json_extract(datos, '$.owner') = 'todos' AND json_extract(datos, '$.date') >= ?1",
	).bind(dia).all();
	for (const f of r.results || []) await sincronizarActividad(env, f.id, buscar);
	return (r.results || []).length;
}
