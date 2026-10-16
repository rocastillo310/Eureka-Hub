// Pruebas de la limpieza semanal del Área general (lunes 0:00 en Guadalajara).
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1Falso } from './d1-falso.js';
import { archivarTerminadas, CRON_SEMANAL } from '../src/semanal.js';
import worker from '../src/index.js';

async function poner(env, tipo, id, datos, borrado = 0) {
	await env.DB.batch([
		env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
		env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT ?1, ?2, ?3, 1, seq, seq, 'ahora', ?4, 'prueba' FROM contador WHERE id = 1")
			.bind(tipo, id, JSON.stringify(datos), borrado),
	]);
}
const act = (id, tipo, obj) => ({ id, t: '2026-10-12T23:00:00Z', por: 'jess', verbo: 'creó', objeto: { tipo, id: obj, titulo: 'X' } });
const leer = async (env, id) => JSON.parse((await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'actividad' AND id = ?1").bind(id).first()).datos);

async function entorno() {
	const env = { DB: d1Falso() };
	await poner(env, 'user', 'ana', { id: 'ana', name: 'Ana', role: 'admin', nivel: 'administracion', aprueba: true, email: 'ana@x.test' });
	await poner(env, 'task', 'publicada', { id: 'publicada', type: 'redes', status: 'publicada' });
	await poner(env, 'task', 'en-curso', { id: 'en-curso', type: 'redes', status: 'redaccion' });
	await poner(env, 'task', 'borrada', { id: 'borrada', type: 'redes', status: 'redaccion' }, 1);
	await poner(env, 'task', 'entregada', { id: 'entregada', type: 'diseno', status: 'entregada' });
	await poner(env, 'entrega', 'aprobada', { id: 'aprobada', version: 1, subidoPor: 'jess', aprobaciones: [{ version: 1, por: 'ana', decision: 'aprobada' }] });
	await poner(env, 'entrega', 'pendiente', { id: 'pendiente', version: 2, subidoPor: 'jess', aprobaciones: [{ version: 1, por: 'ana', decision: 'aprobada' }] });
	await poner(env, 'entrega', 'papelera', { id: 'papelera', version: 1, borrada: { en: 'x' }, aprobaciones: [] });
	for (const [id, tipo, obj] of [['a1', 'task', 'publicada'], ['a2', 'task', 'en-curso'], ['a3', 'task', 'borrada'], ['a4', 'task', 'no-existe'],
		['a5', 'task', 'entregada'], ['a6', 'entrega', 'aprobada'], ['a7', 'entrega', 'pendiente'], ['a8', 'entrega', 'papelera'], ['a9', 'junta', 'j1']]) {
		await poner(env, 'actividad', id, act(id, tipo, obj));
	}
	return env;
}

test('lo terminado (publicada, entregada, borrada, entrega aprobada o en la papelera) pasa al historial; lo demás se queda', async () => {
	const env = await entorno();
	const n = await archivarTerminadas(env, new Date('2026-10-19T06:00:00Z'));
	assert.equal(n, 6);
	const archivadas = [];
	for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) if ((await leer(env, id)).archivada) archivadas.push(id);
	assert.deepEqual(archivadas, ['a1', 'a3', 'a4', 'a5', 'a6', 'a8']);
	assert.equal((await leer(env, 'a1')).archivada.en, '2026-10-19T06:00:00.000Z');
	assert.equal((await leer(env, 'a1')).verbo, 'creó', 'no se borra: se conserva tal cual, solo marcada');
	const b = (await env.DB.prepare('SELECT por, accion, detalle FROM bitacora').all()).results;
	assert.deepEqual(b.map((x) => x.accion), ['Limpieza semanal']);
	assert.match(b[0].detalle, /^6 actividades terminadas/);
	// Correr otra vez no vuelve a tocar nada ni anota de más.
	assert.equal(await archivarTerminadas(env), 0);
	assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM bitacora').first()).n, 1);
});

test('respeta los estados finales que Dirección haya cambiado', async () => {
	const env = await entorno();
	await poner(env, 'stat', 'redes', { v: [{ k: 'redaccion', n: 'Redacción' }, { k: 'lista', n: 'Lista', final: true }] });
	await poner(env, 'task', 'lista', { id: 'lista', type: 'redes', status: 'lista' });
	await poner(env, 'actividad', 'b1', act('b1', 'task', 'lista'));
	await archivarTerminadas(env);
	assert.ok((await leer(env, 'b1')).archivada);
	assert.equal((await leer(env, 'a1')).archivada, undefined, '«publicada» ya no es final en esta configuración');
});

test('el cron de los lunes corre la limpieza y no el respaldo', async () => {
	const env = await entorno();
	const esperas = [];
	await worker.scheduled({ cron: CRON_SEMANAL }, env, { waitUntil: (p) => esperas.push(p) });
	await Promise.all(esperas);
	assert.ok((await leer(env, 'a1')).archivada);
	assert.equal(await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'respaldo'").first(), null);
});

test('las actividades del equipo marcadas «Ya se realizó» salen el lunes; las pendientes y las personales se quedan', async () => {
	const env = await entorno();
	await poner(env, 'ag', 'r1', { id: 'r1', owner: 'todos', title: 'Reunión', date: '2026-10-16', done: true, doneBy: 'ana' });
	await poner(env, 'ag', 'r2', { id: 'r2', owner: 'todos', title: 'Otra', date: '2026-10-20' });
	await poner(env, 'ag', 'r3', { id: 'r3', owner: 'ana', title: 'Personal', date: '2026-10-16', done: true });
	await archivarTerminadas(env, new Date('2026-10-19T06:00:00Z'));
	const ag = async (id) => JSON.parse((await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'ag' AND id = ?1").bind(id).first()).datos);
	assert.ok((await ag('r1')).archivada);
	assert.equal((await ag('r2')).archivada, undefined);
	assert.equal((await ag('r3')).archivada, undefined);
	const b = (await env.DB.prepare('SELECT detalle FROM bitacora').all()).results;
	assert.match(b[0].detalle, /1 actividad del equipo realizada salió de Mi día/);
});
