// Pruebas del respaldo (F5): exportar → vaciar → restaurar → comparar, el aborto si el repo no es privado,
// el commit en GitHub (con un GitHub falso) y los permisos de las rutas.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { d1Falso } from './d1-falso.js';
import { r2Falso } from './r2-falso.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';
import { _reiniciarCache } from '../src/access.js';
import { exportarBase, manifiestoR2, respaldar, fechaLocal } from '../src/respaldo.js';
import { sqlRestauracion, validarRespaldo, huella } from '../src/formato-respaldo.js';

const { buscar: llavesAccess, identidad } = await llavesDePrueba();
globalThis.fetch = llavesAccess;
const PROD = 'https://eureka-hub.cuenta.workers.dev';

// Datos ficticios de prueba (no son el equipo ni los clientes reales).
async function poner(env, tipo, id, datos, borrado = 0) {
	await env.DB.batch([
		env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
		env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT ?1, ?2, ?3, 1, seq, seq, 'ahora', ?4, 'semilla' FROM contador WHERE id = 1")
			.bind(tipo, id, JSON.stringify(datos), borrado),
	]);
}
async function base() {
	const env = { DB: d1Falso(), ENTREGAS: r2Falso(), ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD, RESPALDO_REPO: 'agencia/respaldos', GITHUB_TOKEN_RESPALDO: 'tok-prueba', ASSETS: { fetch: () => new Response('') } };
	await poner(env, 'user', 'ana', { id: 'ana', name: 'Ana', role: 'admin', email: 'ana@agencia.test' });
	await poner(env, 'user', 'beto', { id: 'beto', name: 'Beto', role: '', email: 'beto@agencia.test' });
	await poner(env, 'account', 'c1', { id: 'c1', name: "Cliente D'Uno" });
	await poner(env, 'task', 't1', { id: 't1', acc: 'c1', title: 'Reel «otoño»', com: [{ x: "it's ok" }] });
	await poner(env, 'task', 't2', { id: 't2', acc: 'c1', title: 'Borrada' }, 1);
	// Un tablero de marca grande (como uno con imágenes): pasa de los 100 KB que acepta una sentencia de D1.
	await poner(env, 'board', 'c1', { refs: [{ id: 'r1', img: 'data:image/png;base64,' + 'A'.repeat(180_000), title: "L'imagen" }] });
	await env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('semillado', '1')").run();
	return env;
}
const filas = async (env) => (await env.DB.prepare('SELECT tipo, id, datos, version, seq, borrado FROM entidades').all()).results;

// ---------- exportar → vaciar → restaurar → comparar ----------
test('restaurar sobre una base vacía la deja idéntica al respaldo, incluido un registro de más de 100 KB', async () => {
	const env = await base();
	const r = JSON.parse(JSON.stringify(await exportarBase(env, 'prueba')));
	assert.equal(validarRespaldo(r), null);
	assert.equal(r.entidades.length, 6);
	const vacia = { DB: d1Falso() };
	const sql = sqlRestauracion(r, await filas(vacia), 0);
	assert.ok(sql.split('\n').every((linea) => Buffer.byteLength(linea) < 100_000), 'ninguna sentencia pasa de 100 KB');
	vacia.DB._db.exec(sql);
	assert.equal(huella(await filas(vacia)), huella(r.entidades));
	const c = await vacia.DB.prepare('SELECT seq FROM contador WHERE id = 1').first();
	assert.ok(c.seq >= r.contador);
	assert.equal((await vacia.DB.prepare("SELECT valor FROM meta WHERE clave = 'semillado'").first()).valor, '1');
});

test('restaurar sobre una base con cambios: regresa lo del respaldo, borra lo nuevo y las pantallas lo reciben por sync', async () => {
	const env = await base();
	const r = JSON.parse(JSON.stringify(await exportarBase(env)));
	const cursorAntes = (await env.DB.prepare('SELECT seq FROM contador WHERE id = 1').first()).seq;
	// Después del respaldo alguien cambió una tarea y creó otra.
	await env.DB.prepare("UPDATE entidades SET datos = ?1, version = 5 WHERE tipo = 'task' AND id = 't1'").bind(JSON.stringify({ id: 't1', title: 'Cambiada' })).run();
	await poner(env, 'task', 't9', { id: 't9', title: 'Nueva después del respaldo' });
	env.DB._db.exec(sqlRestauracion(r, await filas(env), (await env.DB.prepare('SELECT seq FROM contador WHERE id = 1').first()).seq));
	const despues = await filas(env);
	assert.equal(JSON.parse(despues.find((f) => f.id === 't1').datos).title, 'Reel «otoño»');
	assert.ok(despues.find((f) => f.id === 't1').version > 5, 'la versión sigue creciendo');
	assert.equal(despues.find((f) => f.id === 't9').borrado, 1);
	assert.equal(huella(despues.filter((f) => f.id !== 't9')), huella(r.entidades));
	// Todo lo restaurado tiene un seq mayor que el cursor que ya tenían las pantallas.
	assert.ok(despues.every((f) => f.seq > cursorAntes));
});

test('validarRespaldo rechaza archivos que no son respaldos o vienen dañados', () => {
	assert.match(validarRespaldo({ hola: 1 }), /no es un respaldo/);
	assert.match(validarRespaldo({ formato: 'eureka-hub-respaldo', version: 1, entidades: [{ tipo: 'task', id: 'x', datos: '{roto' }] }), /dañados/);
});

// ---------- manifiesto de R2 ----------
test('el manifiesto lista los archivos de R2 con tamaño y huella, aunque sean más de 1000', async () => {
	const env = await base();
	for (let i = 0; i < 1003; i++) {
		const m = await env.ENTREGAS.createMultipartUpload(`entregas/c1/e${i}/1-a.pdf`);
		const p = await m.uploadPart(1, new Uint8Array(i % 7 + 1));
		await m.complete([p]);
	}
	const man = await manifiestoR2(env);
	assert.equal(man.total, 1003);
	assert.equal(man.objetos[0].llave, 'entregas/c1/e0/1-a.pdf');
	assert.ok(man.objetos.every((o) => o.etag && o.tamano > 0));
});

// ---------- GitHub falso ----------
function gitHubFalso({ privado = true, vacio = false, nombre = 'agencia/respaldos' } = {}) {
	const llamadas = [], arboles = {}, blobs = {};
	let n = 0, cabeza = vacio ? null : 'c0';
	const commits = vacio ? {} : { c0: { tree: { sha: 'arbol0' } } };
	const json = (cuerpo, estado = 200) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json' } });
	const buscar = async (url, op = {}) => {
		const metodo = op.method || 'GET', ruta = url.replace('https://api.github.com/repos/agencia/respaldos', '');
		const cuerpo = op.body ? JSON.parse(op.body) : null;
		llamadas.push(`${metodo} ${ruta}`);
		assert.equal(op.headers.authorization, 'Bearer tok-prueba');
		if (metodo === 'GET' && ruta === '') return json({ full_name: nombre, private: privado, visibility: privado ? 'private' : 'public', default_branch: 'main' });
		if (metodo === 'GET' && ruta === '/git/ref/heads/main') return cabeza ? json({ object: { sha: cabeza } }) : json({ message: 'Git Repository is empty.' }, 409);
		if (metodo === 'PUT' && ruta === '/contents/README.md') { commits.c0 = { tree: { sha: 'arbol0' } }; cabeza = 'c0'; return json({}, 201); }
		if (metodo === 'GET' && ruta.startsWith('/git/commits/')) return json(commits[ruta.split('/').pop()]);
		if (metodo === 'POST' && ruta === '/git/blobs') { const sha = 'b' + ++n; blobs[sha] = Buffer.from(cuerpo.content, 'base64').toString('utf8'); return json({ sha }, 201); }
		if (metodo === 'POST' && ruta === '/git/trees') { const sha = 't' + ++n; arboles[sha] = cuerpo; return json({ sha }, 201); }
		if (metodo === 'POST' && ruta === '/git/commits') { const sha = 'c' + ++n; commits[sha] = { ...cuerpo, tree: { sha: cuerpo.tree } }; return json({ sha }, 201); }
		if (metodo === 'PATCH' && ruta === '/git/refs/heads/main') { cabeza = cuerpo.sha; return json({}); }
		return json({ message: 'no esperado' }, 500);
	};
	return { buscar, llamadas, arboles, blobs, commits, cabeza: () => cabeza };
}
const ahora = new Date('2026-10-13T09:00:00Z');

test('respaldo a un repo privado: un commit con la base y el manifiesto del día (hora de Guadalajara)', async () => {
	const env = await base();
	const gh = gitHubFalso();
	const r = await respaldar(env, { buscar: gh.buscar, ahora });
	assert.equal(r.ok, true, r.motivo);
	assert.equal(fechaLocal(ahora), '2026-10-13'); // 09:00 UTC = 3:00 a. m. en Guadalajara
	const arbol = Object.values(gh.arboles)[0];
	assert.equal(arbol.base_tree, 'arbol0');
	assert.deepEqual(arbol.tree.map((x) => x.path), ['datos/2026-10-13.json', 'archivos-r2/2026-10-13.json']);
	const respaldo = JSON.parse(gh.blobs[arbol.tree[0].sha]);
	assert.equal(validarRespaldo(respaldo), null);
	assert.equal(respaldo.entidades.length, 6);
	assert.deepEqual(gh.commits[gh.cabeza()].parents, ['c0']);
	assert.match(gh.commits[gh.cabeza()].message, /^Respaldo 2026-10-13 \(cron\): 6 elementos, 0 archivos en R2$/);
	const estado = JSON.parse((await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'respaldo'").first()).valor);
	assert.equal(estado.ok, true);
	assert.equal(estado.commit, gh.cabeza());
});

test('si el repo NO es privado, se aborta sin mandar datos y Dirección recibe el aviso', async () => {
	const env = await base();
	const gh = gitHubFalso({ privado: false });
	const r = await respaldar(env, { buscar: gh.buscar, ahora });
	assert.equal(r.ok, false);
	assert.match(r.motivo, /NO es privado/);
	assert.deepEqual(gh.llamadas, ['GET ']); // solo se consultó el repo: ningún blob ni commit
	const avisos = (await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'inbox'").all()).results.map((f) => JSON.parse(f.datos));
	assert.deepEqual(avisos.map((a) => a.to), ['ana']);
	assert.match(avisos[0].x, /El respaldo diario falló: .*NO es privado/);
});

test('se aborta si el token apunta a otro repo o falta la configuración', async () => {
	const env = await base();
	assert.match((await respaldar(env, { buscar: gitHubFalso({ nombre: 'otra/cosa' }).buscar, ahora })).motivo, /apunta a otra\/cosa/);
	const sinToken = { ...env, GITHUB_TOKEN_RESPALDO: '' };
	assert.match((await respaldar(sinToken, { buscar: () => assert.fail('no debe llamar a GitHub'), ahora })).motivo, /Falta configurar/);
});

test('un repo recién creado y vacío se inicia con un README y luego recibe el respaldo', async () => {
	const env = await base();
	const gh = gitHubFalso({ vacio: true });
	const r = await respaldar(env, { buscar: gh.buscar, ahora, origen: 'manual' });
	assert.equal(r.ok, true, r.motivo);
	assert.ok(gh.llamadas.includes('PUT /contents/README.md'));
	assert.deepEqual(gh.commits[gh.cabeza()].parents, ['c0']);
});

// ---------- rutas ----------
test('solo Dirección consulta el estado del respaldo o lanza uno a mano', async () => {
	_reiniciarCache();
	const env = await base();
	const pedir = async (ruta, como, metodo = 'GET') => (await worker.fetch(new Request(PROD + '/api/' + ruta, { method: metodo, headers: { 'Cf-Access-Jwt-Assertion': await identidad(como) } }), env));
	assert.equal((await pedir('respaldo/estado', 'beto@agencia.test')).status, 403);
	assert.equal((await pedir('respaldo/ahora', 'beto@agencia.test', 'POST')).status, 403);
	const r = await (await pedir('respaldo/estado', 'ana@agencia.test')).json();
	assert.deepEqual(r, { repo: 'agencia/respaldos', configurado: true, ultimo: null });
});
