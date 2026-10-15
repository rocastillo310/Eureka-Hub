// Prueba de trabajo simultáneo contra `wrangler dev` (modo desarrollo, base local).
// Simula a varias personas conectadas a la vez: cada una crea sus tareas y todas editan y comentan la MISMA tarea
// al mismo tiempo, como lo haría la pantalla (sync con base, datos y merge3 en el servidor). Al final comprueba
// que no se perdió ningún cambio.
// Uso: npm run dev (en otra terminal) y luego  node scripts/prueba-concurrencia.mjs [personas] [rondas]
const BASE = process.env.HUB || 'http://localhost:8787';
const [, , nP = '4', nR = '15'] = process.argv;
const personas = ['rodrigo', 'dani', 'jessy', 'monica', 'cyn', 'ivan'].slice(0, Number(nP));
const rondas = Number(nR);
const marca = 'conc' + Date.now().toString(36);

async function sync(quien, desde, cambios) {
	const r = await fetch(BASE + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dev-User': quien }, body: JSON.stringify({ desde, cambios }) });
	if (!r.ok) throw new Error(`${quien}: HTTP ${r.status} ${await r.text()}`);
	return r.json();
}

const comun = `${marca}-comun`;
const inicial = { id: comun, title: 'Tarea compartida', com: [], campos: {} };
await sync(personas[0], 0, [{ tipo: 'task', id: comun, base: null, datos: inicial }]);

let errores = 0;
const inicio = Date.now();
await Promise.all(personas.map(async (quien) => {
	let base = inicial, cursor = 0;
	for (let i = 0; i < rondas; i++) {
		// Lo que haría la pantalla de esta persona: su cambio sobre lo último que recibió del servidor.
		const datos = { ...base, com: [...base.com, { id: `${quien}-${i}`, u: quien, x: `comentario ${i}` }], campos: { ...base.campos, [quien]: i } };
		const propia = { id: `${marca}-${quien}-${i}`, title: `Tarea ${i} de ${quien}` };
		try {
			const r = await sync(quien, cursor, [
				{ tipo: 'task', id: comun, base, datos },
				{ tipo: 'task', id: propia.id, base: null, datos: propia },
			]);
			cursor = r.cursor;
			const e = r.entidades.find((x) => x.tipo === 'task' && x.id === comun);
			base = e ? e.datos : datos;
		} catch (err) {
			errores++;
			console.error(err.message);
		}
	}
}));
const ms = Date.now() - inicio;

const todo = await (await fetch(BASE + '/api/bootstrap', { headers: { 'X-Dev-User': personas[0] } })).json();
let entidades = todo.entidades, cursor = todo.cursor, mas = todo.mas;
while (mas) { const r = await sync(personas[0], cursor, []); entidades = entidades.concat(r.entidades); cursor = r.cursor; mas = r.mas; }
const tareas = entidades.filter((e) => e.tipo === 'task' && e.id.startsWith(marca) && !e.borrado);
const c = tareas.find((e) => e.id === comun).datos;
const propias = tareas.filter((e) => e.id !== comun).length;
const esperadas = personas.length * rondas;
const ok = propias === esperadas && c.com.length === esperadas && personas.every((p) => c.campos[p] === rondas - 1) && !errores;
console.log(`${personas.length} personas × ${rondas} rondas en paralelo (${esperadas * 2} cambios en ${ms} ms)`);
console.log(`Tareas propias guardadas: ${propias}/${esperadas}`);
console.log(`Comentarios en la tarea compartida: ${c.com.length}/${esperadas}`);
console.log(`Último cambio de cada persona en la tarea compartida: ${personas.map((p) => `${p}=${c.campos[p]}`).join(', ')}`);
console.log(`Errores: ${errores}`);
console.log(ok ? 'RESULTADO: no se perdió ningún cambio.' : 'RESULTADO: algo no coincide.');
process.exit(ok ? 0 : 1);
