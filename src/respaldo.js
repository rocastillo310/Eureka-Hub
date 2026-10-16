// Respaldo diario (F5). Un Cron Trigger (09:00 UTC = 3:00 a. m. en Guadalajara) exporta la base en JSON y un
// manifiesto de los archivos de R2 (llave, tamaño, huella; NO los archivos) y los guarda con un commit en un repo
// de GitHub PRIVADO y distinto del código. Antes de escribir revisa por la API que el repo sea privado; si no lo es,
// aborta sin mandar nada.
//
// Configuración: RESPALDO_REPO ("dueño/repo", variable) y GITHUB_TOKEN_RESPALDO (secreto): token fino de GitHub
// limitado a ese repo con permiso de contenido de lectura y escritura.
// Archivos por día: datos/AAAA-MM-DD.json y archivos-r2/AAAA-MM-DD.json (un solo commit). La historia de git
// conserva cada versión.
import { armarRespaldo } from './formato-respaldo.js';
import { guardarDelServidor } from './entidades.js';

const API = 'https://api.github.com';
const LIMITE_BYTES = 50 * 1024 * 1024; // GitHub advierte desde 50 MiB y rechaza más de 100 MiB por archivo

class Falla extends Error {}

// Fecha del respaldo en hora de Guadalajara (el cron corre en UTC).
export function fechaLocal(d = new Date()) {
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function exportarBase(env, origen = '') {
	const r = await env.DB.prepare('SELECT tipo, id, datos, version, seq, creado, actualizado, borrado, por FROM entidades ORDER BY seq').all();
	const c = await env.DB.prepare('SELECT seq FROM contador WHERE id = 1').first();
	const m = await env.DB.prepare('SELECT clave, valor FROM meta').all();
	return armarRespaldo({ entidades: r.results || [], contador: c ? c.seq : 0, meta: m.results || [], origen });
}

// Lista de los objetos del bucket: con esto se sabe qué archivos existían y se puede comprobar una copia aparte.
// La huella es el etag de R2 (MD5 del archivo si se subió de una vez; si se subió en partes, MD5 de las partes y «-N»).
export async function manifiestoR2(env) {
	const objetos = [];
	let cursor;
	do {
		const l = await env.ENTREGAS.list({ cursor, limit: 1000 });
		for (const o of l.objects) objetos.push({ llave: o.key, tamano: o.size, etag: o.etag, subido: o.uploaded instanceof Date ? o.uploaded.toISOString() : o.uploaded });
		cursor = l.truncated ? l.cursor : undefined;
	} while (cursor);
	return { generado: new Date().toISOString(), total: objetos.length, bytes: objetos.reduce((a, o) => a + o.tamano, 0), objetos };
}

function base64(texto) {
	const b = new TextEncoder().encode(texto);
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
}

function clienteGitHub(repo, token, buscar) {
	return async (ruta, op = {}) => {
		const r = await buscar(`${API}/repos/${repo}${ruta}`, {
			method: op.method || 'GET',
			headers: {
				authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
				'user-agent': 'eureka-hub-worker', ...(op.body ? { 'content-type': 'application/json' } : {}),
			},
			body: op.body ? JSON.stringify(op.body) : undefined,
		});
		const j = await r.json().catch(() => ({}));
		if (op.permitir && op.permitir.includes(r.status)) return { estado: r.status, j };
		if (!r.ok) throw new Falla(`GitHub respondió ${r.status} en ${ruta || 'el repo'}${j.message ? `: ${j.message}` : ''}`);
		return { estado: r.status, j };
	};
}

const README = '# Respaldos de Centro Eureka Hub\n\nRepositorio PRIVADO. Lo escribe solo el Worker `eureka-hub` cada día a las 3:00 a. m. (Guadalajara).\n\n' +
	'- `datos/AAAA-MM-DD.json`: la base completa. Se restaura con `npm run restore -- <archivo>` en el repo del código.\n' +
	'- `archivos-r2/AAAA-MM-DD.json`: lista de los archivos de R2 (llave, tamaño y huella). Los archivos en sí no están aquí.\n\n' +
	'Contiene datos personales del equipo y de clientes: nunca lo hagas público.\n';

// Hace el respaldo. Devuelve { ok, ... } y deja el resultado en meta.respaldo para verlo en Ajustes.
export async function respaldar(env, { origen = 'cron', buscar = fetch, ahora = new Date() } = {}) {
	const repo = (env.RESPALDO_REPO || '').trim(), token = (env.GITHUB_TOKEN_RESPALDO || '').trim();
	const fecha = fechaLocal(ahora);
	let res;
	try {
		if (!repo || !token) throw new Falla('Falta configurar el respaldo (RESPALDO_REPO y el secreto GITHUB_TOKEN_RESPALDO)');
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Falla('RESPALDO_REPO debe ser «dueño/repo»');
		const gh = clienteGitHub(repo, token, buscar);

		// 1. El repo destino debe existir, ser el configurado y ser PRIVADO. Si no, no se manda nada.
		const { j: info } = await gh('', { permitir: [404] }).then((r) => {
			if (r.estado === 404) throw new Falla(`No encuentro el repo ${repo} (o el token no tiene acceso a él)`);
			return r;
		});
		if (String(info.full_name || '').toLowerCase() !== repo.toLowerCase()) throw new Falla(`El token apunta a ${info.full_name}, no a ${repo}`);
		if (info.private !== true || (info.visibility && info.visibility !== 'private')) {
			throw new Falla(`El repo ${repo} NO es privado: respaldo cancelado para no publicar datos`);
		}

		// 2. Los datos.
		const datos = JSON.stringify(await exportarBase(env, origen));
		const archivos = JSON.stringify(await manifiestoR2(env), null, 1);
		if (datos.length > LIMITE_BYTES) throw new Falla('El respaldo pasa de 50 MB; GitHub ya no lo aceptaría bien');

		// 3. Commit con los dos archivos (API de datos de git: blobs → árbol → commit → mover la rama).
		const rama = info.default_branch || 'main';
		let ref = await gh(`/git/ref/heads/${rama}`, { permitir: [404, 409] });
		if (ref.estado !== 200) {
			// Repo vacío: el primer archivo se crea con la API de contenidos, que sí funciona sin commits.
			await gh('/contents/README.md', { method: 'PUT', body: { message: 'Inicio de los respaldos', content: base64(README), branch: rama } });
			ref = await gh(`/git/ref/heads/${rama}`);
		}
		const padre = ref.j.object.sha;
		const { j: commitPadre } = await gh(`/git/commits/${padre}`);
		const blob = async (texto) => (await gh('/git/blobs', { method: 'POST', body: { content: base64(texto), encoding: 'base64' } })).j.sha;
		const [bDatos, bArchivos] = [await blob(datos), await blob(archivos)];
		const { j: arbol } = await gh('/git/trees', { method: 'POST', body: { base_tree: commitPadre.tree.sha, tree: [
			{ path: `datos/${fecha}.json`, mode: '100644', type: 'blob', sha: bDatos },
			{ path: `archivos-r2/${fecha}.json`, mode: '100644', type: 'blob', sha: bArchivos },
		] } });
		const total = JSON.parse(datos).entidades.length, nArchivos = JSON.parse(archivos).total;
		const { j: commit } = await gh('/git/commits', { method: 'POST', body: {
			message: `Respaldo ${fecha} (${origen}): ${total} elementos, ${nArchivos} archivos en R2`, tree: arbol.sha, parents: [padre],
		} });
		await gh(`/git/refs/heads/${rama}`, { method: 'PATCH', body: { sha: commit.sha } });
		res = { ok: true, fecha, en: ahora.toISOString(), origen, commit: commit.sha, repo, elementos: total, archivos: nArchivos, bytes: datos.length };
	} catch (e) {
		res = { ok: false, fecha, en: ahora.toISOString(), origen, motivo: e instanceof Falla ? e.message : 'Error inesperado: ' + (e && e.message) };
	}
	await env.DB.prepare('INSERT INTO meta (clave, valor) VALUES (?1, ?2) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor')
		.bind('respaldo', JSON.stringify(res)).run();
	if (!res.ok) {
		console.log(JSON.stringify({ respaldo: 'falló', motivo: res.motivo }));
		// Aviso en la Bandeja de la persona dueña del respaldo (RESPALDO_DUENO) cuando falla el automático (si aún no se
		// conecta GitHub, solo queda registrado, para no avisar cada noche).
		const dueno = (env.RESPALDO_DUENO || '').trim();
		if (origen === 'cron' && repo && token && dueno) {
			const admins = ((await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'user' AND borrado = 0").all()).results || [])
				.map((f) => JSON.parse(f.datos)).filter((u) => u.id === dueno && !u.baja);
			for (const u of admins) {
				const id = 'i' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
				await guardarDelServidor(env, 'inbox', id, () => ({ id, to: u.id, t: new Date().toISOString(), x: `El respaldo diario falló: ${res.motivo}`, task: '', read: false }), 'servidor');
			}
		}
	}
	return res;
}

export async function estadoRespaldo(env) {
	const m = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'respaldo'").first();
	return m ? JSON.parse(m.valor) : null;
}
