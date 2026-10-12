// Pruebas de las entregas (F2) contra una D1 y un R2 falsos: subida en partes, versiones, descarga con Range,
// validaciones del servidor, permisos y borrado.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { d1Falso } from './d1-falso.js';
import { r2Falso } from './r2-falso.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';
import { _reiniciarCache } from '../src/access.js';
import { nombreSeguro } from '../src/entregas.js';

const { buscar, identidad } = await llavesDePrueba();
globalThis.fetch = buscar;

const PROD = 'https://eureka-hub.cuenta.workers.dev';
const LOCAL = 'http://localhost:8787';
const MIB = 1024 * 1024;

// Datos ficticios de prueba (no son el equipo ni los clientes reales).
const ANA = { id: 'ana', name: 'Ana', role: 'admin', email: 'ana@agencia.test', aprueba: true };
const BETO = { id: 'beto', name: 'Beto', role: '', email: 'beto@agencia.test', aprueba: false };
const CARO = { id: 'caro', name: 'Caro', role: '', email: 'caro@agencia.test', aprueba: false };
const ana = 'ana@agencia.test', beto = 'beto@agencia.test', caro = 'caro@agencia.test';

async function poner(env, tipo, id, datos) {
	await env.DB.batch([
		env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
		env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT ?1, ?2, ?3, 1, seq, seq, 'ahora', 0, 'semilla' FROM contador WHERE id = 1")
			.bind(tipo, id, JSON.stringify(datos)),
	]);
}

async function entorno({ dev = false } = {}) {
	_reiniciarCache();
	const env = { DB: d1Falso(), ENTREGAS: r2Falso(), ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD, MAX_ARCHIVO_MB: '40', PARTE_MB: '5', ASSETS: { fetch: () => new Response('estático') } };
	if (dev) env.DEV_LOGIN = '1';
	for (const u of [ANA, BETO, CARO]) await poner(env, 'user', u.id, u);
	await poner(env, 'account', 'c1', { id: 'c1', name: 'Cliente Uno' });
	await poner(env, 'account', 'c2', { id: 'c2', name: 'Cliente Dos' });
	await poner(env, 'list', 'l1', { id: 'l1', acc: 'c1', type: 'redes', name: 'Octubre' });
	await poner(env, 'list', 'l2', { id: 'l2', acc: 'c2', type: 'redes', name: 'Octubre' });
	await poner(env, 'task', 't1', { id: 't1', acc: 'c1', list: 'l1', title: 'Reel' });
	await env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('semillado', '1')").run();
	return env;
}

async function pedir(env, ruta, { metodo, cuerpo, crudo, como, base = PROD, cab = {} } = {}) {
	const headers = { ...cab };
	if (como) headers['Cf-Access-Jwt-Assertion'] = await identidad(como);
	let body;
	if (crudo) { body = crudo; headers['content-length'] = String(crudo.length); }
	else if (cuerpo !== undefined) { body = JSON.stringify(cuerpo); headers['content-type'] = 'application/json'; }
	const r = await worker.fetch(new Request(base + '/api/' + ruta, { method: metodo || (body === undefined ? 'GET' : 'POST'), headers, body }), env);
	return r;
}
const json = async (r) => ({ estado: r.status, json: await r.json() });

// Bytes reconocibles: cada posición guarda su número módulo 251, así un rango mal cortado se nota.
function bytesDe(tamano) {
	const b = new Uint8Array(tamano);
	for (let i = 0; i < tamano; i++) b[i] = i % 251;
	return b;
}

async function subir(env, como, datos, contenido) {
	const ini = await json(await pedir(env, 'entregas/iniciar', { como, cuerpo: { tamano: contenido.length, ...datos } }));
	assert.equal(ini.estado, 200, JSON.stringify(ini.json));
	const { subida, parteBytes, partes } = ini.json;
	for (let n = 1; n <= partes; n++) {
		const trozo = contenido.slice((n - 1) * parteBytes, n * parteBytes);
		const r = await pedir(env, `entregas/parte?subida=${subida}&n=${n}`, { metodo: 'PUT', como, crudo: trozo });
		assert.equal(r.status, 200, await r.clone().text());
	}
	const fin = await json(await pedir(env, 'entregas/completar', { como, cuerpo: { subida } }));
	assert.equal(fin.estado, 200, JSON.stringify(fin.json));
	return { ...ini.json, entrega: fin.json.entrega };
}

const fila = async (env, tipo, id) => {
	const f = await env.DB.prepare('SELECT datos, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
	return f && !f.borrado ? JSON.parse(f.datos) : null;
};
const actividades = async (env) => ((await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'actividad' AND borrado = 0 ORDER BY seq").all()).results || []).map((f) => JSON.parse(f.datos));

// ---------- subida completa ----------
test('se sube un video de 11 MiB en 3 partes y queda la entrega con lo que estampa el servidor', async () => {
	const env = await entorno();
	const contenido = bytesDe(11 * MIB);
	const r = await subir(env, beto, { archivo: 'Reel Brisña final.MP4', nombre: 'Reel Brisña', cuentaId: 'c1', listaId: 'l1', tareaId: 't1', notas: 'Corte de 30 s', subidoPor: 'ana' }, contenido);
	assert.equal(r.partes, 3);
	const e = await fila(env, 'entrega', r.entregaId);
	assert.equal(e.nombre, 'Reel Brisña');
	assert.equal(e.archivo, 'Reel Brisña final.MP4');
	assert.equal(e.mime, 'video/mp4');
	assert.equal(e.tamano, contenido.length);
	assert.equal(e.version, 1);
	assert.equal(e.subidoPor, 'beto'); // el servidor ignora lo que mande la pantalla
	assert.equal(e.creadoPor, 'beto');
	assert.equal(e.estado, 'pendiente');
	assert.deepEqual(e.aprobaciones, []);
	assert.equal(e.r2Key, `entregas/c1/${r.entregaId}/1-Reel-Brisna-final.mp4`);
	assert.equal(e.listaId, 'l1');
	assert.equal(e.tareaId, 't1');
	assert.equal(e.notas, 'Corte de 30 s');
	assert.deepEqual(env.ENTREGAS._objetos.get(e.r2Key).bytes, contenido);
	assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subidas').first()).n, 0);
	assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subida_partes').first()).n, 0);
	const act = await actividades(env);
	assert.equal(act.length, 1);
	assert.equal(act[0].por, 'beto');
	assert.equal(act[0].verbo, 'entregó');
	assert.deepEqual(act[0].objeto, { tipo: 'entrega', id: r.entregaId, titulo: 'Reel Brisña' });
	assert.equal(act[0].cuentaId, 'c1');
});

test('la entrega llega a las demás pantallas por sync', async () => {
	const env = await entorno();
	const b = await json(await pedir(env, 'bootstrap', { como: ana }));
	const r = await subir(env, beto, { archivo: 'logo.png', cuentaId: 'c1' }, bytesDe(1000));
	const s = await json(await pedir(env, 'sync', { como: ana, cuerpo: { desde: b.json.cursor, cambios: [] } }));
	const tipos = s.json.entidades.map((x) => x.tipo + ':' + (x.tipo === 'entrega' ? x.id : '')).sort();
	assert.deepEqual(tipos, ['actividad:', 'entrega:' + r.entregaId]);
	assert.equal(s.json.entidades.find((x) => x.tipo === 'entrega').datos.nombre, 'logo'); // sin nombre, se usa el del archivo
});

// ---------- versiones ----------
test('subir sobre una entrega crea la versión 2, conserva la 1 y vuelve a «pendiente»', async () => {
	const env = await entorno();
	const v1 = await subir(env, beto, { archivo: 'reel.mp4', nombre: 'Reel', cuentaId: 'c1' }, bytesDe(6 * MIB));
	// Simula que en la v1 pidieron cambios (F3 lo hará con su ruta; aquí se escribe directo).
	const e1 = await fila(env, 'entrega', v1.entregaId);
	await env.DB.prepare("UPDATE entidades SET datos = ?1 WHERE tipo = 'entrega' AND id = ?2").bind(JSON.stringify({ ...e1, estado: 'cambios', aprobaciones: [{ por: 'ana', decision: 'cambios' }] }), v1.entregaId).run();
	const v2 = await subir(env, caro, { entregaId: v1.entregaId, archivo: 'reel v2.mov', notas: 'Ajusté el color', cuentaId: 'c2', nombre: 'Otro nombre' }, bytesDe(2 * MIB));
	assert.equal(v2.version, 2);
	const e = await fila(env, 'entrega', v1.entregaId);
	assert.equal(e.version, 2);
	assert.equal(e.nombre, 'Reel'); // el nombre y la cuenta de la entrega no cambian con la versión
	assert.equal(e.cuentaId, 'c1');
	assert.equal(e.archivo, 'reel v2.mov');
	assert.equal(e.mime, 'video/quicktime');
	assert.equal(e.subidoPor, 'caro');
	assert.equal(e.creadoPor, 'beto');
	assert.equal(e.estado, 'pendiente');
	assert.deepEqual(e.aprobaciones, []);
	assert.deepEqual(e.versiones.map((v) => [v.version, v.subidoPor]), [[1, 'beto'], [2, 'caro']]);
	assert.equal(e.versiones[1].notas, 'Ajusté el color');
	assert.equal(env.ENTREGAS._objetos.size, 2);
	const v1Desc = await pedir(env, `entregas/archivo?id=${v1.entregaId}&v=1`, { como: ana });
	assert.equal(v1Desc.status, 200);
	assert.equal(v1Desc.headers.get('content-type'), 'video/mp4');
	const act = await actividades(env);
	assert.ok(act.some((a) => a.verbo === 'subió una versión nueva de' && a.detalle === 'Versión 2' && a.por === 'caro'));
});

test('dos versiones nuevas a la vez reciben números distintos', async () => {
	const env = await entorno();
	const v1 = await subir(env, beto, { archivo: 'a.pdf', cuentaId: 'c1' }, bytesDe(100));
	const [x, y] = await Promise.all([beto, caro].map(async (como) =>
		(await json(await pedir(env, 'entregas/iniciar', { como, cuerpo: { entregaId: v1.entregaId, archivo: 'a.pdf', tamano: 100 } }))).json));
	assert.deepEqual([x.version, y.version].sort(), [2, 3]);
});

// ---------- descarga y vista previa ----------
test('descarga completa, con Range y fuera de rango', async () => {
	const env = await entorno();
	const contenido = bytesDe(6 * MIB + 7);
	const { entregaId } = await subir(env, beto, { archivo: 'video.mp4', cuentaId: 'c1' }, contenido);
	const todo = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana });
	assert.equal(todo.status, 200);
	assert.equal(todo.headers.get('accept-ranges'), 'bytes');
	assert.equal(todo.headers.get('content-length'), String(contenido.length));
	assert.match(todo.headers.get('content-disposition'), /^inline; filename="video.mp4"/);
	assert.equal(todo.headers.get('x-content-type-options'), 'nosniff');
	assert.deepEqual(new Uint8Array(await todo.arrayBuffer()), contenido);

	const parte = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana, cab: { range: 'bytes=5242880-5242899' } });
	assert.equal(parte.status, 206);
	assert.equal(parte.headers.get('content-range'), `bytes 5242880-5242899/${contenido.length}`);
	assert.deepEqual(new Uint8Array(await parte.arrayBuffer()), contenido.slice(5242880, 5242900));

	const abierto = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana, cab: { range: `bytes=${contenido.length - 3}-` } });
	assert.equal(abierto.status, 206);
	assert.deepEqual(new Uint8Array(await abierto.arrayBuffer()), contenido.slice(-3));

	const sufijo = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana, cab: { range: 'bytes=-10' } });
	assert.deepEqual(new Uint8Array(await sufijo.arrayBuffer()), contenido.slice(-10));

	const fuera = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana, cab: { range: `bytes=${contenido.length}-` } });
	assert.equal(fuera.status, 416);
	assert.equal(fuera.headers.get('content-range'), `bytes */${contenido.length}`);

	const cab = await pedir(env, `entregas/archivo?id=${entregaId}`, { como: ana, metodo: 'HEAD' });
	assert.equal(cab.status, 200);
	assert.equal(cab.headers.get('content-length'), String(contenido.length));
});

test('descargar=1 baja con el nombre original; SVG y otros tipos nunca se abren dentro de la app', async () => {
	const env = await entorno();
	const a = await subir(env, beto, { archivo: 'Logotipo café.svg', cuentaId: 'c1' }, bytesDe(50));
	const r = await pedir(env, `entregas/archivo?id=${a.entregaId}`, { como: ana });
	assert.equal(r.headers.get('content-disposition'), `attachment; filename="Logotipo cafe.svg"; filename*=UTF-8''Logotipo%20caf%C3%A9.svg`);
	assert.match(r.headers.get('content-security-policy'), /sandbox/);
	assert.equal(r.headers.get('cache-control'), 'private, no-store'); // sin ?v= puede cambiar de versión
	const pdf = await subir(env, beto, { archivo: 'brief.pdf', cuentaId: 'c1' }, bytesDe(50));
	const rp = await pedir(env, `entregas/archivo?id=${pdf.entregaId}&v=1`, { como: ana });
	assert.match(rp.headers.get('content-disposition'), /^inline;/);
	assert.equal(rp.headers.get('content-security-policy'), null); // Chrome no muestra PDF con sandbox
	assert.match(rp.headers.get('cache-control'), /immutable/);
	assert.match((await pedir(env, `entregas/archivo?id=${pdf.entregaId}&v=1&descargar=1`, { como: ana })).headers.get('content-security-policy'), /sandbox/);
	const b = await subir(env, beto, { archivo: 'foto.jpg', cuentaId: 'c1' }, bytesDe(50));
	assert.match((await pedir(env, `entregas/archivo?id=${b.entregaId}&descargar=1`, { como: ana })).headers.get('content-disposition'), /^attachment;/);
});

// ---------- validaciones del servidor ----------
test('el servidor rechaza tipos no permitidos, archivos vacíos o muy grandes, y cuentas, listas o tareas ajenas', async () => {
	const env = await entorno();
	const ini = (cuerpo) => pedir(env, 'entregas/iniciar', { como: beto, cuerpo: { archivo: 'a.mp4', tamano: 10, cuentaId: 'c1', ...cuerpo } }).then(json);
	assert.equal((await ini({ archivo: 'virus.exe' })).estado, 415);
	assert.equal((await ini({ archivo: 'pagina.html' })).estado, 415);
	assert.equal((await ini({ archivo: 'sinextension' })).estado, 415);
	assert.equal((await ini({ tamano: 0 })).estado, 400);
	assert.equal((await ini({ tamano: 1.5 })).estado, 400);
	assert.equal((await ini({ tamano: 40 * MIB + 1 })).estado, 413);
	assert.equal((await ini({ cuentaId: 'no-existe' })).estado, 400);
	assert.equal((await ini({ listaId: 'l2' })).estado, 400); // lista de otra cuenta
	assert.equal((await ini({ tareaId: 'nada' })).estado, 400);
	assert.equal((await ini({ entregaId: 'no-existe' })).estado, 404);
	assert.equal((await ini({})).estado, 200);
});

test('cada parte debe medir lo esperado y solo la sube quien inició la subida', async () => {
	const env = await entorno();
	const { json: s } = await json(await pedir(env, 'entregas/iniciar', { como: beto, cuerpo: { archivo: 'v.mp4', tamano: 6 * MIB, cuentaId: 'c1' } }));
	assert.equal(s.partes, 2);
	const corta = await pedir(env, `entregas/parte?subida=${s.subida}&n=1`, { metodo: 'PUT', como: beto, crudo: bytesDe(100) });
	assert.equal(corta.status, 400);
	const ajena = await pedir(env, `entregas/parte?subida=${s.subida}&n=1`, { metodo: 'PUT', como: caro, crudo: bytesDe(5 * MIB) });
	assert.equal(ajena.status, 403);
	const fuera = await pedir(env, `entregas/parte?subida=${s.subida}&n=3`, { metodo: 'PUT', como: beto, crudo: bytesDe(MIB) });
	assert.equal(fuera.status, 400);
	// Completar con partes faltantes dice cuáles faltan.
	await pedir(env, `entregas/parte?subida=${s.subida}&n=2`, { metodo: 'PUT', como: beto, crudo: bytesDe(MIB) });
	const falta = await json(await pedir(env, 'entregas/completar', { como: beto, cuerpo: { subida: s.subida } }));
	assert.equal(falta.estado, 409);
	assert.deepEqual(falta.json.faltan, [1]);
	// Reintentar una parte la reemplaza.
	await pedir(env, `entregas/parte?subida=${s.subida}&n=1`, { metodo: 'PUT', como: beto, crudo: bytesDe(5 * MIB) });
	await pedir(env, `entregas/parte?subida=${s.subida}&n=1`, { metodo: 'PUT', como: beto, crudo: bytesDe(5 * MIB) });
	assert.equal((await pedir(env, 'entregas/completar', { como: beto, cuerpo: { subida: s.subida } })).status, 200);
});

test('abortar cancela la subida en R2 y la borra de la base', async () => {
	const env = await entorno();
	const { json: s } = await json(await pedir(env, 'entregas/iniciar', { como: beto, cuerpo: { archivo: 'v.mp4', tamano: 100, cuentaId: 'c1' } }));
	assert.equal(env.ENTREGAS._subidas.size, 1);
	assert.equal((await pedir(env, 'entregas/abortar', { como: beto, cuerpo: { subida: s.subida } })).status, 200);
	assert.equal(env.ENTREGAS._subidas.size, 0);
	assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subidas').first()).n, 0);
	assert.equal((await pedir(env, `entregas/parte?subida=${s.subida}&n=1`, { metodo: 'PUT', como: beto, crudo: bytesDe(100) })).status, 404);
});

// ---------- permisos ----------
test('sin identidad no se sube ni se descarga', async () => {
	const env = await entorno();
	const { entregaId } = await subir(env, beto, { archivo: 'a.pdf', cuentaId: 'c1' }, bytesDe(10));
	assert.equal((await pedir(env, `entregas/archivo?id=${entregaId}`)).status, 401);
	assert.equal((await pedir(env, 'entregas/iniciar', { cuerpo: { archivo: 'a.pdf', tamano: 10, cuentaId: 'c1' } })).status, 401);
	assert.equal((await pedir(env, `entregas/archivo?id=${entregaId}`, { como: 'intruso@otro.test' })).status, 401);
});

test('?devUser= solo sirve en desarrollo local, nunca en producción', async () => {
	const env = await entorno({ dev: true });
	const { entregaId } = await subir(env, beto, { archivo: 'a.pdf', cuentaId: 'c1' }, bytesDe(10));
	assert.equal((await pedir(env, `entregas/archivo?id=${entregaId}&devUser=ana`)).status, 401);
	assert.equal((await pedir(env, `entregas/archivo?id=${entregaId}&devUser=ana`, { base: LOCAL })).status, 200);
});

test('ni siquiera Dirección puede escribir entregas o actividad por sync', async () => {
	const env = await entorno();
	const { entregaId } = await subir(env, beto, { archivo: 'a.pdf', cuentaId: 'c1' }, bytesDe(10));
	const e = await fila(env, 'entrega', entregaId);
	const s = await json(await pedir(env, 'sync', { como: ana, cuerpo: { desde: 0, cambios: [
		{ tipo: 'entrega', id: entregaId, base: e, datos: { ...e, estado: 'aprobada', subidoPor: 'ana' } },
		{ tipo: 'actividad', id: 'x1', base: null, datos: { id: 'x1', por: 'beto', verbo: 'inventó' } },
		{ tipo: 'entrega', id: 'falsa', base: null, datos: { id: 'falsa', r2Key: 'entregas/otra/cosa' } },
	] } }));
	assert.equal(s.json.rechazados.length, 3);
	assert.equal((await fila(env, 'entrega', entregaId)).estado, 'pendiente');
	assert.equal(await fila(env, 'actividad', 'x1'), null);
	assert.equal(await fila(env, 'entrega', 'falsa'), null);
});

// ---------- borrado ----------
test('borrado: lógico primero, solo Dirección o quien la creó; el definitivo pide BORRAR y libera R2', async () => {
	const env = await entorno();
	const v1 = await subir(env, beto, { archivo: 'reel.mp4', cuentaId: 'c1' }, bytesDe(1000));
	await subir(env, caro, { entregaId: v1.entregaId, archivo: 'reel2.mp4' }, bytesDe(2000));
	const id = v1.entregaId;
	// Caro subió la versión 2 pero no creó la entrega: no puede borrarla.
	assert.equal((await pedir(env, 'entregas/borrar', { como: caro, cuerpo: { id } })).status, 403);
	assert.equal((await pedir(env, 'entregas/purgar', { como: beto, cuerpo: { id, confirmar: 'BORRAR' } })).status, 409); // aún no está en la papelera
	assert.equal((await pedir(env, 'entregas/borrar', { como: beto, cuerpo: { id } })).status, 200);
	assert.equal((await fila(env, 'entrega', id)).borrada.por, 'beto');
	assert.equal(env.ENTREGAS._objetos.size, 2); // el borrado lógico no toca R2
	assert.equal((await pedir(env, 'entregas/restaurar', { como: ana, cuerpo: { id } })).status, 200);
	assert.equal((await fila(env, 'entrega', id)).borrada, undefined);
	await pedir(env, 'entregas/borrar', { como: ana, cuerpo: { id } });
	assert.equal((await pedir(env, 'entregas/purgar', { como: ana, cuerpo: { id } })).status, 400); // sin confirmación
	assert.equal((await pedir(env, 'entregas/purgar', { como: caro, cuerpo: { id, confirmar: 'BORRAR' } })).status, 403);
	assert.equal((await pedir(env, 'entregas/purgar', { como: ana, cuerpo: { id, confirmar: 'BORRAR' } })).status, 200);
	assert.equal(env.ENTREGAS._objetos.size, 0);
	assert.equal(await fila(env, 'entrega', id), null);
	assert.equal((await pedir(env, `entregas/archivo?id=${id}`, { como: ana })).status, 404);
	const verbos = (await actividades(env)).map((a) => a.verbo);
	assert.deepEqual(verbos.filter((v) => /papelera|restauró|definitivamente/.test(v)), ['mandó a la papelera', 'restauró', 'mandó a la papelera', 'borró definitivamente']);
	assert.match((await actividades(env)).find((a) => a.verbo === 'borró definitivamente').detalle, /^2 versiones/);
});

test('nombres seguros para la llave de R2', () => {
	assert.equal(nombreSeguro('Reel Brisña v2 (final).mp4'), 'Reel-Brisna-v2-final.mp4');
	assert.equal(nombreSeguro('../../etc/passwd'), 'etc-passwd');
	assert.equal(nombreSeguro('ñññ.pdf'), 'nnn.pdf');
	assert.equal(nombreSeguro('???.pdf'), 'archivo.pdf');
});
