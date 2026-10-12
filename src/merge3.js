// Mezcla de cambios de tres vías. Módulo único del servidor; la pantalla (public/index.html) lleva una copia
// idéntica en comportamiento, y tests/merge3-prototipo.test.js comprueba que ambas den lo mismo.
//
// merge3(base, local, remoto): base = lo último que la persona recibió del servidor, local = lo que ella tiene ahora,
// remoto = lo que el servidor tiene ahora. Devuelve el resultado de aplicar los cambios de la persona sobre lo remoto:
// - campo que la persona no tocó: se queda lo remoto
// - campo de texto/número/etc. que sí tocó: gana lo de la persona (último en guardar, pero solo en ese campo)
// - lista (comentarios, historial, subtareas, personas…): se suman los elementos nuevos y se quitan solo los que la
//   persona quitó, sin tocar lo que otras personas agregaron
// - objeto: se mezcla clave por clave

// JSON estable: mismas claves en distinto orden dan el mismo texto.
export function sj(x) {
	if (x === null || typeof x !== 'object') return JSON.stringify(x === undefined ? null : x);
	if (Array.isArray(x)) return '[' + x.map(sj).join(',') + ']';
	return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + sj(x[k])).join(',') + '}';
}

const cl = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const esObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const claveItem = (it) => (esObj(it) && it.id !== undefined ? 'i:' + it.id : 'j:' + sj(it));

function mezclaLista(base, local, remoto) {
	const kb = {}, kl = {};
	base.forEach((x) => { kb[claveItem(x)] = x; });
	local.forEach((x) => { kl[claveItem(x)] = x; });
	const quitados = {}, cambiados = {}, nuevos = [];
	Object.keys(kb).forEach((k) => { if (!(k in kl)) quitados[k] = 1; });
	local.forEach((x) => {
		const k = claveItem(x);
		if (!(k in kb)) nuevos.push(x);
		else if (sj(kb[k]) !== sj(x)) cambiados[k] = x;
	});
	const sal = [], vistos = {};
	remoto.forEach((x) => {
		const k = claveItem(x);
		if (quitados[k]) return;
		sal.push(k in cambiados ? cl(cambiados[k]) : cl(x));
		vistos[k] = 1;
	});
	nuevos.forEach((x) => {
		const k = claveItem(x);
		if (!vistos[k]) { sal.push(cl(x)); vistos[k] = 1; }
	});
	return sal;
}

export function merge3(base, local, remoto) {
	base = base || {};
	remoto = remoto || {};
	const sal = cl(remoto);
	Object.keys(local).forEach((k) => {
		const b = base[k], l = local[k], r = remoto[k];
		if (sj(b) === sj(l)) return;
		if (Array.isArray(l) && (Array.isArray(r) || r === undefined) && (Array.isArray(b) || b === undefined)) sal[k] = mezclaLista(b || [], l, r || []);
		else if (esObj(l) && (esObj(r) || r === undefined) && (esObj(b) || b === undefined)) sal[k] = merge3(b, l, r);
		else sal[k] = cl(l);
	});
	Object.keys(base).forEach((k) => { if (!(k in local)) delete sal[k]; });
	return sal;
}
