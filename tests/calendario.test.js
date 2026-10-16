// Pruebas de las invitaciones de Google Calendar (Google falso, sin red).
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1Falso } from './d1-falso.js';
import { aEvento, eventoId, sincronizarActividad, sincronizarProximas, completarConexion, urlConectar, _reiniciarCache } from '../src/calendario.js';
import { armarRespaldo } from '../src/formato-respaldo.js';

const ORIGEN = 'https://hub.test';
const ENV_G = { GOOGLE_CLIENT_ID: 'cliente', GOOGLE_CLIENT_SECRET: 'secreto' };

async function poner(env, tipo, id, datos, borrado = 0) {
	await env.DB.batch([
		env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
		env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT ?1, ?2, ?3, 1, seq, seq, 'ahora', ?4, 'prueba' FROM contador WHERE id = 1 ON CONFLICT (tipo, id) DO UPDATE SET datos = excluded.datos, borrado = excluded.borrado")
			.bind(tipo, id, JSON.stringify(datos), borrado),
	]);
}

async function entorno({ conectado = true } = {}) {
	_reiniciarCache();
	const env = { DB: d1Falso(), ...ENV_G };
	await poner(env, 'user', 'ana', { id: 'ana', name: 'Ana', role: 'admin', email: 'ana@agencia.test' });
	await poner(env, 'user', 'beto', { id: 'beto', name: 'Beto', role: '', email: 'Beto@Agencia.test' });
	await poner(env, 'user', 'caro', { id: 'caro', name: 'Caro', role: '', email: 'caro@agencia.test', baja: { en: 'x' } });
	await poner(env, 'account', 'a-brizna', { id: 'a-brizna', name: 'Brizna' });
	if (conectado) await env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('google_token', 'refresco')").run();
	return env;
}

// Google falso: guarda eventos por id y registra las llamadas.
function googleFalso() {
	const eventos = new Map(), llamadas = [];
	const buscar = async (url, op = {}) => {
		const metodo = op.method || 'GET';
		llamadas.push({ url, metodo, cuerpo: op.body && typeof op.body === 'string' ? JSON.parse(op.body) : null });
		const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
		if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'acceso', expires_in: 3600, refresh_token: 'nuevo' });
		const m = url.match(/\/events\/([a-v0-9]+)\?/);
		if (m && metodo === 'PUT') { if (!eventos.has(m[1])) return json({}, 404); eventos.set(m[1], JSON.parse(op.body)); return json({}); }
		if (m && metodo === 'DELETE') { eventos.delete(m[1]); return json({}, 204); }
		if (url.includes('/events?') && metodo === 'POST') { const b = JSON.parse(op.body); eventos.set(b.id, b); return json(b); }
		if (url.endsWith('/calendars/primary')) return json({ id: 'ana@agencia.test' });
		return json({}, 400);
	};
	return { buscar, eventos, llamadas };
}

const REUNION = { id: 'a1', kind: 'act', title: 'Reunión Brizna', date: '2026-10-16', time: '13:00', owner: 'todos', acc: 'a-brizna', link: 'https://meet.google.com/abc-defg-hij', notes: '', by: 'ana' };

test('el id del evento solo usa caracteres que Google acepta', () => {
	assert.match(eventoId('a3e3e79acf2f5'), /^[a-v0-9]{5,1024}$/);
});

test('la reunión dura una hora en hora de Guadalajara; sin hora es de todo el día', () => {
	const e = aEvento({ ...REUNION, time: '23:30' }, ['ana@agencia.test'], 'Brizna');
	assert.deepEqual(e.start, { dateTime: '2026-10-16T23:30:00', timeZone: 'America/Mexico_City' });
	assert.deepEqual(e.end, { dateTime: '2026-10-17T00:30:00', timeZone: 'America/Mexico_City' });
	assert.match(e.description, /Entrar: https:\/\/meet\.google\.com\/abc-defg-hij/);
	const d = aEvento({ ...REUNION, time: '' }, [], '');
	assert.deepEqual([d.start, d.end], [{ date: '2026-10-16' }, { date: '2026-10-17' }]);
});

test('reunión del equipo con enlace: invita a cada persona activa (no a quien está de baja) y Google manda el correo', async () => {
	const env = await entorno(), g = googleFalso();
	await poner(env, 'ag', 'a1', REUNION);
	const r = await sincronizarActividad(env, 'a1', g.buscar);
	assert.deepEqual(r, { ok: true, accion: 'enviada' });
	const ev = g.eventos.get(eventoId('a1'));
	assert.deepEqual(ev.attendees.map((a) => a.email), ['ana@agencia.test', 'beto@agencia.test']);
	assert.ok(g.llamadas.filter((l) => l.metodo !== 'GET' && !l.url.includes('oauth2')).every((l) => l.url.includes('sendUpdates=all')));
	assert.equal(ev.summary, 'Reunión Brizna');
});

test('editar solo las notas no vuelve a mandar correos; cambiar la hora sí actualiza la invitación', async () => {
	const env = await entorno(), g = googleFalso();
	await poner(env, 'ag', 'a1', REUNION);
	await sincronizarActividad(env, 'a1', g.buscar);
	const antes = g.llamadas.length;
	assert.deepEqual(await sincronizarActividad(env, 'a1', g.buscar), { ok: true, accion: 'sin cambios' });
	assert.equal(g.llamadas.length, antes);
	await poner(env, 'ag', 'a1', { ...REUNION, time: '16:00' });
	assert.deepEqual(await sincronizarActividad(env, 'a1', g.buscar), { ok: true, accion: 'actualizada' });
	assert.equal(g.eventos.get(eventoId('a1')).start.dateTime, '2026-10-16T16:00:00');
});

test('borrar la actividad o quitarle el enlace cancela la invitación', async () => {
	const env = await entorno(), g = googleFalso();
	await poner(env, 'ag', 'a1', REUNION);
	await sincronizarActividad(env, 'a1', g.buscar);
	await poner(env, 'ag', 'a1', { ...REUNION, link: '' });
	assert.deepEqual(await sincronizarActividad(env, 'a1', g.buscar), { ok: true, accion: 'cancelada' });
	assert.equal(g.eventos.size, 0);
});

test('actividades personales, sin enlace o sin Google conectado no mandan nada', async () => {
	const g = googleFalso();
	const env = await entorno();
	await poner(env, 'ag', 'p1', { ...REUNION, id: 'p1', owner: 'ana' });
	await poner(env, 'ag', 'p2', { ...REUNION, id: 'p2', link: '' });
	assert.deepEqual(await sincronizarActividad(env, 'p1', g.buscar), { omitido: true });
	assert.deepEqual(await sincronizarActividad(env, 'p2', g.buscar), { omitido: true });
	const sin = await entorno({ conectado: false });
	await poner(sin, 'ag', 'a1', REUNION);
	assert.deepEqual(await sincronizarActividad(sin, 'a1', g.buscar), { omitido: true });
	assert.equal(g.llamadas.length, 0);
});

test('al conectar: valida el estado, guarda la llave e invita a las reuniones que aún no pasan', async () => {
	const env = await entorno({ conectado: false }), g = googleFalso();
	await poner(env, 'ag', 'a1', REUNION);
	await poner(env, 'ag', 'vieja', { ...REUNION, id: 'vieja', date: '2026-10-01' });
	const url = new URL(await urlConectar(env, ORIGEN));
	assert.equal(url.searchParams.get('redirect_uri'), 'https://hub.test/api/google/callback');
	assert.equal(url.searchParams.get('access_type'), 'offline');
	assert.equal((await completarConexion(env, ORIGEN, 'codigo', 'otro-estado', g.buscar)).ok, false);
	const url2 = new URL(await urlConectar(env, ORIGEN));
	assert.deepEqual(await completarConexion(env, ORIGEN, 'codigo', url2.searchParams.get('state'), g.buscar), { ok: true });
	assert.equal(await sincronizarProximas(env, g.buscar, new Date('2026-10-16T12:00:00Z')), 1);
	assert.ok(g.eventos.has(eventoId('a1')));
	assert.ok(!g.eventos.has(eventoId('vieja')));
});

test('la llave de Google y su estado nunca entran al respaldo', () => {
	const r = armarRespaldo({ entidades: [], contador: 0, meta: [{ clave: 'google_token', valor: 'x' }, { clave: 'google_ev_a1', valor: 'y' }, { clave: 'semillado', valor: '1' }] });
	assert.deepEqual(r.meta.map((m) => m.clave), ['semillado']);
});
