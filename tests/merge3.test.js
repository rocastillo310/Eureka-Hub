// Pruebas del núcleo de mezcla de tres vías (src/merge3.js) y de que la copia de la pantalla se comporte igual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { merge3, sj } from '../src/merge3.js';

const tarea = () => ({ id: 't1', title: 'Post', status: 'redaccion', assignees: ['ana'], com: [], hist: [], subs: [], priority: null });

test('dos personas agregan un comentario cada una: se conservan los dos', () => {
	const base = tarea();
	const remoto = { ...base, com: [{ u: 'beto', t: '1', x: 'de Beto' }] };
	const local = { ...base, com: [{ u: 'ana', t: '2', x: 'de Ana' }] };
	assert.deepEqual(merge3(base, local, remoto).com.map((c) => c.x), ['de Beto', 'de Ana']);
});

test('cada persona cambia un campo distinto: se conservan los dos cambios', () => {
	const base = tarea();
	const r = merge3(base, { ...base, priority: 'alta' }, { ...base, title: 'Post nuevo' });
	assert.equal(r.priority, 'alta');
	assert.equal(r.title, 'Post nuevo');
});

test('las dos cambian el mismo campo: gana la última en guardar, solo en ese campo', () => {
	const base = tarea();
	const r = merge3(base, { ...base, status: 'diseno' }, { ...base, status: 'cliente', priority: 'urgente' });
	assert.equal(r.status, 'diseno');
	assert.equal(r.priority, 'urgente');
});

test('quitar una subtarea no borra las que agregó otra persona', () => {
	const base = { ...tarea(), subs: [{ id: 's1', title: 'A', done: false }, { id: 's2', title: 'B', done: false }] };
	const remoto = { ...base, subs: [...base.subs, { id: 's3', title: 'C', done: false }] };
	const local = { ...base, subs: [base.subs[1]] };
	assert.deepEqual(merge3(base, local, remoto).subs.map((s) => s.id), ['s2', 's3']);
});

test('marcar una subtarea hecha conserva la subtarea nueva de otra persona', () => {
	const base = { ...tarea(), subs: [{ id: 's1', title: 'A', done: false }] };
	const remoto = { ...base, subs: [...base.subs, { id: 's2', title: 'B', done: false }] };
	const local = { ...base, subs: [{ id: 's1', title: 'A', done: true }] };
	assert.deepEqual(merge3(base, local, remoto).subs.map((s) => [s.id, s.done]), [['s1', true], ['s2', false]]);
});

test('asignar a alguien no quita a quien otra persona asignó', () => {
	const base = tarea();
	const r = merge3(base, { ...base, assignees: ['ana', 'caro'] }, { ...base, assignees: ['ana', 'beto'] });
	assert.deepEqual(r.assignees.sort(), ['ana', 'beto', 'caro']);
});

test('objetos anidados se mezclan clave por clave', () => {
	const base = { id: 't1', fired: {} };
	assert.deepEqual(merge3(base, { ...base, fired: { au11: true } }, { ...base, fired: { au12: true } }).fired, { au11: true, au12: true });
});

test('un campo que la persona quitó se quita; uno nuevo se agrega', () => {
	assert.equal('desc' in merge3({ id: 'x', desc: 'a' }, { id: 'x' }, { id: 'x', desc: 'a' }), false);
	assert.equal(merge3({ id: 'x' }, { id: 'x', copy: 'hola' }, { id: 'x' }).copy, 'hola');
});

test('elemento sin base: lo de la persona se aplica sobre lo remoto', () => {
	const r = merge3(null, { id: 't9', title: 'Nueva' }, { id: 't9', title: 'Otra', extra: 1 });
	assert.equal(r.title, 'Nueva');
	assert.equal(r.extra, 1);
});

test('sin cambios de la persona queda exactamente lo remoto', () => {
	const base = tarea();
	const remoto = { ...base, status: 'diseno', com: [{ x: '1' }] };
	assert.equal(sj(merge3(base, base, remoto)), sj(remoto));
});

test('el resultado no comparte referencias con las entradas', () => {
	const base = tarea();
	const local = { ...base, com: [{ x: 'a' }] };
	const r = merge3(base, local, base);
	r.com[0].x = 'cambiado';
	assert.equal(local.com[0].x, 'a');
});

test('sj ordena las claves: mismo contenido, mismo texto', () => {
	assert.equal(sj({ b: 1, a: [2, { d: 1, c: 2 }] }), sj({ a: [2, { c: 2, d: 1 }], b: 1 }));
	assert.notEqual(sj({ a: 1 }), sj({ a: 2 }));
});

test('10 personas comentan a la vez desde la misma base vieja y no se pierde ninguno', () => {
	const base = tarea();
	let servidor = base;
	for (let i = 0; i < 10; i++) servidor = merge3(base, { ...base, com: [{ u: 'u' + i, t: String(i), x: 'c' + i }] }, servidor);
	assert.equal(servidor.com.length, 10);
});

// La pantalla lleva su propia copia de merge3 (no usa módulos). Esta prueba la extrae de public/index.html
// y comprueba que dé exactamente lo mismo que el módulo del servidor en todos los casos de arriba y algunos más.
test('la copia de la pantalla da el mismo resultado que el servidor', () => {
	const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
	const ini = html.indexOf('function sj(x)');
	const fin = html.indexOf('\n}', html.indexOf('function merge3(base,local,remoto)')) + 2;
	assert.ok(ini > 0 && fin > ini, 'no se encontró merge3 en public/index.html');
	const deLaPantalla = new Function(html.slice(ini, fin) + '\nreturn merge3;')();
	const base = { ...tarea(), subs: [{ id: 's1', done: false }], fired: { a: 1 } };
	const casos = [
		[base, { ...base, status: 'diseno', com: [{ x: 1 }] }, { ...base, priority: 'alta', com: [{ x: 2 }] }],
		[base, { ...base, subs: [] }, { ...base, subs: [...base.subs, { id: 's2' }] }],
		[base, { ...base, fired: { a: 1, b: 2 } }, { ...base, fired: { c: 3 } }],
		[null, { id: 'n', v: 1 }, { id: 'n', w: 2 }],
		[{ id: 'x', k: 1 }, { id: 'x' }, { id: 'x', k: 1, z: [1, 2] }],
		[base, { ...base, assignees: [] }, { ...base, assignees: ['ana', 'beto'] }],
	];
	for (const [b, l, r] of casos) assert.equal(sj(deLaPantalla(b, l, r)), sj(merge3(b, l, r)));
});
