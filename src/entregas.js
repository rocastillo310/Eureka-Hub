// Entregas (F2): archivos que el equipo entrega, guardados en el bucket privado de R2. Toda subida y descarga pasa por
// el Worker, con la identidad ya verificada.
//
// Subida en partes (multipart de R2), porque un Worker no recibe peticiones de más de 100 MB en los planes Free y Pro
// (documentación de Cloudflare, Workers > Limits, consultada el 12 oct 2026):
//   POST /api/entregas/iniciar    {archivo, nombre, tamano, cuentaId, listaId?, tareaId?, notas?, entregaId?}
//   PUT  /api/entregas/parte?subida=…&n=…   (cuerpo: los bytes de la parte n)
//   POST /api/entregas/completar  {subida}
//   POST /api/entregas/abortar    {subida}
//   POST /api/entregas/decidir    {id, version, decision: "aprobada"|"cambios", comentario?}   (F3)
// Reglas de R2 (R2 > Upload objects): partes de 5 MiB a 5 GiB, todas iguales salvo la última, máximo 10,000 partes.
// Se usan partes de 50 MiB: caben con margen en los 100 MB del Worker y un reel de 4 GB son 82 partes.
//
// El servidor decide la llave del objeto, el tipo (por la extensión, no por lo que diga el navegador), el número de
// versión, el autor y la hora. La entidad `entrega` y la `actividad` solo las escribe el servidor.
import { guardarDelServidor, leerEntidad } from './entidades.js';

const MIB = 1024 * 1024;
const CAB = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });
const error = (estado, mensaje, extra = {}) => resp({ error: mensaje, ...extra }, estado);

// Extensiones permitidas y el tipo con que se guardan. Lo que no está aquí se rechaza (ejecutables, páginas web…).
export const TIPOS_ARCHIVO = {
	mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
	jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
	heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', svg: 'image/svg+xml',
	mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
	pdf: 'application/pdf',
	doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
	key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
	txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf',
	zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
	psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript', eps: 'application/postscript',
	indd: 'application/x-indesign', idml: 'application/vnd.adobe.indesign-idml-package',
	fig: 'application/octet-stream', sketch: 'application/octet-stream', xd: 'application/octet-stream',
	aep: 'application/octet-stream', prproj: 'application/octet-stream', mogrt: 'application/octet-stream',
	otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
};
// Tipos que el navegador muestra dentro de la app. Todo lo demás (incluido SVG, que puede llevar código) solo se descarga.
export const VISTA_PREVIA = new Set([
	'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
	'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
	'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac',
	'application/pdf',
]);

const ID_OK = /^[A-Za-z0-9_-]{1,80}$/;
const nuevoId = (prefijo) => prefijo + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const ahora = () => new Date().toISOString();

export function maxBytes(env) {
	const mb = Number(env.MAX_ARCHIVO_MB);
	return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 2000) * MIB);
}
// PARTE_MB solo existe para las pruebas; se acota a lo que permiten R2 (≥ 5 MiB) y el Worker (< 100 MB).
export function parteBytes(env, tamano = 0) {
	const mb = Math.min(95, Math.max(5, Number(env.PARTE_MB) || 50));
	return Math.max(mb * MIB, Math.ceil(tamano / 10_000)); // nunca más de 10,000 partes
}

export function extension(nombre) {
	const m = /.\.([A-Za-z0-9]{1,10})$/.exec(nombre);
	return m ? m[1].toLowerCase() : '';
}
// Nombre para mostrar: sin caracteres de control ni rutas, espacios normalizados.
export function nombreLimpio(x, max = 180) {
	return String(x || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Nombre para la llave de R2: solo letras sin acento, números, punto, guion y guion bajo.
export function nombreSeguro(nombre) {
	const ext = extension(nombre);
	const base = (ext ? nombre.slice(0, -(ext.length + 1)) : nombre)
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 90);
	return (base || 'archivo') + (ext ? '.' + ext : '');
}
function disposicion(tipo, nombre) {
	const ascii = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const utf = encodeURIComponent(nombre).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
	return `${tipo}; filename="${ascii}"; filename*=UTF-8''${utf}`;
}

async function leerJson(request) {
	const texto = await request.text();
	if (texto.length > 20_000) throw new Error('demasiado grande');
	return JSON.parse(texto);
}

const puedeBorrar = (usuario, e) => usuario.role === 'admin' || e.creadoPor === usuario.id;

// ---------- aprobación (F3) ----------
// Ajustes que decide Dirección. Valores iniciales PROVISIONALES (el prompt los deja pendientes): basta una aprobación
// y quien subió la entrega no puede aprobarla.
export const AJUSTES_APROBACION = { regla: 'uno', autorAprueba: false };
async function ajustesAprobacion(env) {
	const a = await leerEntidad(env, 'ajuste', 'aprobacion');
	const d = (a && a.datos) || {};
	return { regla: d.regla === 'todos' ? 'todos' : 'uno', autorAprueba: d.autorAprueba === true };
}
async function equipo(env) {
	const r = await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'user' AND borrado = 0").all();
	return (r.results || []).map((f) => JSON.parse(f.datos));
}
const puedeAprobar = (u, e, aj) => !!u.aprueba && (aj.autorAprueba || u.id !== e.subidoPor);

// Estado de la versión actual según la última decisión de cada persona: cualquier «cambios» pendiente gana; si no,
// con la regla «uno» basta una aprobación y con «todos» deben aprobar todas las personas que pueden aprobarla.
export function estadoDe(e, usuarios, aj) {
	const ultimas = new Map();
	for (const a of e.aprobaciones || []) if (a.version === e.version) ultimas.set(a.por, a);
	const votos = [...ultimas.values()];
	if (votos.some((a) => a.decision === 'cambios')) return 'cambios';
	const si = new Set(votos.filter((a) => a.decision === 'aprobada').map((a) => a.por));
	if (aj.regla === 'todos') {
		const deben = usuarios.filter((u) => puedeAprobar(u, e, aj)).map((u) => u.id);
		return deben.length && deben.every((id) => si.has(id)) ? 'aprobada' : 'pendiente';
	}
	return si.size ? 'aprobada' : 'pendiente';
}

// Aviso en la Bandeja de una persona (la misma forma que crea la pantalla, con `entrega` para abrirla).
async function avisar(env, para, texto, e) {
	const id = nuevoId('i');
	await guardarDelServidor(env, 'inbox', id, () => ({ id, to: para, t: ahora(), x: texto, task: '', entrega: e.id, read: false }), 'servidor');
}

async function registrarActividad(env, por, verbo, e, detalle) {
	const id = nuevoId('act');
	const datos = { id, t: ahora(), por, verbo, objeto: { tipo: 'entrega', id: e.id, titulo: e.nombre }, cuentaId: e.cuentaId };
	if (detalle) datos.detalle = detalle;
	await guardarDelServidor(env, 'actividad', id, () => datos, por);
}

// ---------- subida ----------
async function iniciar(request, env, usuario) {
	const b = await leerJson(request);
	const archivo = nombreLimpio(b.archivo);
	if (!archivo) return error(400, 'Falta el nombre del archivo');
	const ext = extension(archivo), mime = TIPOS_ARCHIVO[ext];
	if (!mime) return error(415, ext ? `No se aceptan archivos .${ext}` : 'El archivo no tiene extensión (por ejemplo .mp4 o .pdf)');
	const tamano = b.tamano;
	if (!Number.isSafeInteger(tamano) || tamano <= 0) return error(400, 'El archivo está vacío');
	if (tamano > maxBytes(env)) return error(413, `El archivo pasa del máximo permitido (${Math.round(maxBytes(env) / MIB)} MB)`);
	const notas = nombreLimpio(b.notas, 2000);

	let entregaId, cuentaId, listaId = '', tareaId = '', nombre, baseVersion = 0;
	if (b.entregaId) {
		// Nueva versión de una entrega que ya existe: hereda cuenta, lista y tarea.
		const e = typeof b.entregaId === 'string' && ID_OK.test(b.entregaId) ? await leerEntidad(env, 'entrega', b.entregaId) : null;
		if (!e || !e.datos || e.datos.borrada) return error(404, 'Esa entrega ya no existe');
		({ id: entregaId, cuentaId, nombre } = e.datos);
		baseVersion = Math.max(0, ...(e.datos.versiones || []).map((v) => v.version));
	} else {
		cuentaId = typeof b.cuentaId === 'string' && ID_OK.test(b.cuentaId) ? b.cuentaId : '';
		const cuenta = cuentaId ? await leerEntidad(env, 'account', cuentaId) : null;
		if (!cuenta || !cuenta.datos) return error(400, 'Elige una cuenta que exista');
		if (b.listaId) {
			const l = ID_OK.test(String(b.listaId)) ? await leerEntidad(env, 'list', String(b.listaId)) : null;
			if (!l || !l.datos || l.datos.acc !== cuentaId) return error(400, 'Esa lista no es de la cuenta elegida');
			listaId = String(b.listaId);
		}
		if (b.tareaId) {
			const t = ID_OK.test(String(b.tareaId)) ? await leerEntidad(env, 'task', String(b.tareaId)) : null;
			if (!t || !t.datos || t.datos.acc !== cuentaId) return error(400, 'Esa tarea no es de la cuenta elegida');
			tareaId = String(b.tareaId);
		}
		entregaId = nuevoId('e');
		nombre = nombreLimpio(b.nombre) || archivo.slice(0, archivo.length - ext.length - 1) || archivo;
	}

	// Reserva el número de versión. UNIQUE (entrega_id, version) evita que dos subidas simultáneas tomen el mismo.
	const parte = parteBytes(env, tamano), partes = Math.ceil(tamano / parte);
	const subida = nuevoId('s');
	const datos = JSON.stringify({ archivo, mime, nombre, cuentaId, listaId, tareaId, notas, nueva: !b.entregaId });
	let version = 0;
	for (let intento = 0; intento < 5 && !version; intento++) {
		const p = await env.DB.prepare('SELECT MAX(version) AS v FROM subidas WHERE entrega_id = ?1').bind(entregaId).first();
		const v = Math.max(baseVersion, (p && p.v) || 0) + 1;
		const r = await env.DB.prepare(
			'INSERT INTO subidas (id, upload_id, r2_key, entrega_id, version, por, datos, tamano, parte, partes, creado) ' +
			"VALUES (?1, '', '', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (entrega_id, version) DO NOTHING",
		).bind(subida, entregaId, v, usuario.id, datos, tamano, parte, partes, ahora()).run();
		if (r.meta.changes === 1) version = v;
	}
	if (!version) return error(409, 'Otra persona está subiendo una versión de esta entrega. Intenta de nuevo.');

	const r2Key = `entregas/${cuentaId}/${entregaId}/${version}-${nombreSeguro(archivo)}`;
	try {
		const mpu = await env.ENTREGAS.createMultipartUpload(r2Key, {
			httpMetadata: { contentType: mime },
			customMetadata: { entrega: entregaId, version: String(version), por: usuario.id },
		});
		await env.DB.prepare('UPDATE subidas SET upload_id = ?2, r2_key = ?3 WHERE id = ?1').bind(subida, mpu.uploadId, r2Key).run();
	} catch (e) {
		await env.DB.prepare('DELETE FROM subidas WHERE id = ?1').bind(subida).run();
		throw e;
	}
	return resp({ subida, entregaId, version, parteBytes: parte, partes });
}

async function subidaDe(env, id, usuario) {
	if (typeof id !== 'string' || !ID_OK.test(id)) return { err: error(400, 'Subida inválida') };
	const s = await env.DB.prepare('SELECT * FROM subidas WHERE id = ?1').bind(id).first();
	if (!s || !s.upload_id) return { err: error(404, 'Esa subida ya no existe. Vuelve a subir el archivo.') };
	if (s.por !== usuario.id && usuario.role !== 'admin') return { err: error(403, 'Esa subida es de otra persona') };
	return { s };
}

async function subirParte(request, env, usuario, url) {
	const { s, err } = await subidaDe(env, url.searchParams.get('subida'), usuario);
	if (err) return err;
	if (s.por !== usuario.id) return error(403, 'Esa subida es de otra persona');
	const n = Number(url.searchParams.get('n'));
	if (!Number.isInteger(n) || n < 1 || n > s.partes) return error(400, 'Número de parte inválido');
	const esperado = n < s.partes ? s.parte : s.tamano - s.parte * (s.partes - 1);
	const largo = Number(request.headers.get('content-length'));
	if (largo !== esperado || !request.body) return error(400, `La parte ${n} debe medir ${esperado} bytes`);
	const mpu = env.ENTREGAS.resumeMultipartUpload(s.r2_key, s.upload_id);
	const p = await mpu.uploadPart(n, request.body);
	await env.DB.prepare(
		'INSERT INTO subida_partes (subida, n, etag, tamano) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (subida, n) DO UPDATE SET etag = excluded.etag, tamano = excluded.tamano',
	).bind(s.id, n, p.etag, esperado).run();
	return resp({ n });
}

async function limpiarSubida(env, id) {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM subida_partes WHERE subida = ?1').bind(id),
		env.DB.prepare('DELETE FROM subidas WHERE id = ?1').bind(id),
	]);
}

async function completar(request, env, usuario) {
	const b = await leerJson(request);
	const { s, err } = await subidaDe(env, b.subida, usuario);
	if (err) return err;
	const r = await env.DB.prepare('SELECT n, etag, tamano FROM subida_partes WHERE subida = ?1 ORDER BY n').bind(s.id).all();
	const partes = r.results || [];
	if (partes.length !== s.partes) {
		const tiene = new Set(partes.map((p) => p.n));
		const faltan = [];
		for (let n = 1; n <= s.partes; n++) if (!tiene.has(n)) faltan.push(n);
		return error(409, 'Faltan partes del archivo', { faltan });
	}
	const mpu = env.ENTREGAS.resumeMultipartUpload(s.r2_key, s.upload_id);
	const obj = await mpu.complete(partes.map((p) => ({ partNumber: p.n, etag: p.etag })));
	if (obj.size !== s.tamano) {
		await env.ENTREGAS.delete(s.r2_key);
		await limpiarSubida(env, s.id);
		return error(500, 'El archivo llegó incompleto. Vuelve a subirlo.');
	}
	const d = JSON.parse(s.datos);
	const v = { version: s.version, archivo: d.archivo, mime: d.mime, tamano: s.tamano, r2Key: s.r2_key, subidoPor: s.por, subidoEn: ahora() };
	if (!d.nueva && d.notas) v.notas = d.notas;
	let esNueva = false;
	const e = await guardarDelServidor(env, 'entrega', s.entrega_id, (actual) => {
		esNueva = !actual;
		const versiones = [...((actual && actual.versiones) || []).filter((x) => x.version !== v.version), v].sort((a, z) => a.version - z.version);
		const ult = versiones[versiones.length - 1];
		const esUltima = ult.version === v.version;
		return {
			...(actual || {}),
			id: s.entrega_id,
			nombre: actual ? actual.nombre : d.nombre,
			cuentaId: actual ? actual.cuentaId : d.cuentaId,
			listaId: actual ? actual.listaId || '' : d.listaId,
			tareaId: actual ? actual.tareaId || '' : d.tareaId,
			notas: actual ? actual.notas || '' : d.notas,
			creadoPor: actual ? actual.creadoPor : s.por,
			creadoEn: actual ? actual.creadoEn : v.subidoEn,
			archivo: ult.archivo, mime: ult.mime, tamano: ult.tamano, r2Key: ult.r2Key, version: ult.version, subidoPor: ult.subidoPor, subidoEn: ult.subidoEn,
			// Una versión nueva vuelve a revisión: las aprobaciones son de la versión que se vio.
			estado: esUltima || !actual ? 'pendiente' : actual.estado || 'pendiente',
			aprobaciones: esUltima || !actual ? [] : actual.aprobaciones || [],
			versiones,
		};
	}, usuario.id);
	await limpiarSubida(env, s.id);
	await registrarActividad(env, s.por, esNueva ? 'entregó' : 'subió una versión nueva de', e, esNueva ? undefined : `Versión ${s.version}`);
	// Aviso a quienes pueden aprobar esta versión (nunca a quien la subió).
	if (e.version === s.version) {
		const aj = await ajustesAprobacion(env), usuarios = await equipo(env);
		const cuenta = await leerEntidad(env, 'account', e.cuentaId);
		const donde = cuenta && cuenta.datos ? ` en ${cuenta.datos.name}` : '';
		const quien = (usuarios.find((u) => u.id === s.por) || {}).name || s.por;
		for (const u of usuarios) {
			if (u.id === s.por || !puedeAprobar(u, e, aj)) continue;
			await avisar(env, u.id, esNueva ? `${quien} entregó «${e.nombre}»${donde}: falta tu aprobación` : `${quien} subió la versión ${e.version} de «${e.nombre}»${donde}: falta tu aprobación`, e);
		}
	}
	return resp({ entrega: e });
}

async function abortar(request, env, usuario) {
	const b = await leerJson(request);
	const { s, err } = await subidaDe(env, b.subida, usuario);
	if (err) return err.status === 404 ? resp({ ok: true }) : err;
	try { await env.ENTREGAS.resumeMultipartUpload(s.r2_key, s.upload_id).abort(); } catch { /* R2 ya la había cerrado */ }
	await limpiarSubida(env, s.id);
	return resp({ ok: true });
}

async function decidir(request, env, usuario) {
	const b = await leerJson(request);
	const decision = b.decision;
	if (decision !== 'aprobada' && decision !== 'cambios') return error(400, 'Decisión inválida');
	const comentario = nombreLimpio(b.comentario, 2000);
	if (decision === 'cambios' && !comentario) return error(400, 'Escribe qué hay que cambiar');
	const e0 = await entregaPara(env, b.id);
	if (!e0 || !e0.datos || e0.datos.borrada) return error(404, 'Esa entrega no existe');
	const aj = await ajustesAprobacion(env), usuarios = await equipo(env);
	if (!usuario.aprueba) return error(403, 'No tienes permiso para aprobar entregas. Dirección lo activa en Equipo.');
	let motivo = null, antes = null;
	const e = await guardarDelServidor(env, 'entrega', b.id, (actual) => {
		motivo = null;
		if (!actual || actual.borrada) { motivo = [404, 'Esa entrega no existe']; return undefined; }
		if (actual.version !== b.version) { motivo = [409, `Ya hay una versión más nueva (la ${actual.version}). Revísala antes de decidir.`]; return undefined; }
		if (!puedeAprobar(usuario, actual, aj)) { motivo = [403, 'No puedes aprobar tu propia entrega (se cambia en Ajustes)']; return undefined; }
		antes = actual.estado || 'pendiente';
		const voto = { por: usuario.id, en: ahora(), decision, version: actual.version };
		if (comentario) voto.comentario = comentario;
		const quitaMio = (lista) => (lista || []).filter((a) => !(a.por === usuario.id && a.version === actual.version));
		const x = { ...actual, aprobaciones: [...quitaMio(actual.aprobaciones), voto] };
		x.versiones = (actual.versiones || []).map((v) => (v.version === actual.version ? { ...v, aprobaciones: [...quitaMio(v.aprobaciones), voto] } : v));
		x.estado = estadoDe(x, usuarios, aj);
		return x;
	}, usuario.id);
	if (motivo) return error(motivo[0], motivo[1]);
	await registrarActividad(env, usuario.id, decision === 'aprobada' ? 'aprobó' : 'pidió cambios en', e,
		decision === 'cambios' ? comentario : `Versión ${e.version}`);
	// «Cambios» regresa la entrega a quien la subió; cuando queda aprobada, también se le avisa.
	const nombre = usuario.name || usuario.id;
	if (decision === 'cambios' && e.subidoPor !== usuario.id) await avisar(env, e.subidoPor, `${nombre} pidió cambios en «${e.nombre}»: ${comentario}`, e);
	if (e.estado === 'aprobada' && antes !== 'aprobada' && e.subidoPor !== usuario.id) await avisar(env, e.subidoPor, `«${e.nombre}» quedó aprobada`, e);
	return resp({ entrega: e });
}

// ---------- descarga y vista previa (con Range para el video) ----------
function rango(cabecera, tamano) {
	if (!cabecera) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(cabecera.trim());
	if (!m || (m[1] === '' && m[2] === '')) return null; // varios rangos o formato raro: se manda el archivo completo
	if (m[1] === '') {
		const sufijo = Number(m[2]);
		if (!sufijo) return 'invalido';
		return { inicio: Math.max(0, tamano - sufijo), fin: tamano - 1 };
	}
	const inicio = Number(m[1]), fin = m[2] === '' ? tamano - 1 : Math.min(Number(m[2]), tamano - 1);
	if (inicio >= tamano || fin < inicio) return 'invalido';
	return { inicio, fin };
}

async function archivo(request, env, url) {
	const id = url.searchParams.get('id') || '';
	const e = ID_OK.test(id) ? await leerEntidad(env, 'entrega', id) : null;
	if (!e || !e.datos) return error(404, 'Esa entrega no existe');
	const pedida = url.searchParams.get('v');
	const v = pedida ? (e.datos.versiones || []).find((x) => String(x.version) === pedida) : (e.datos.versiones || []).find((x) => x.version === e.datos.version);
	if (!v) return error(404, 'Esa versión no existe');

	const enLinea = VISTA_PREVIA.has(v.mime) && url.searchParams.get('descargar') !== '1';
	const h = new Headers({
		'content-type': v.mime,
		'content-disposition': disposicion(enLinea ? 'inline' : 'attachment', v.archivo),
		'accept-ranges': 'bytes',
		// Con ?v= el contenido nunca cambia (cada versión es otro objeto): el navegador lo guarda y no lo vuelve a bajar.
		'cache-control': pedida ? 'private, max-age=31536000, immutable' : 'private, no-store',
		'x-content-type-options': 'nosniff',
	});
	// Aunque alguien lograra subir algo activo, el navegador lo abre sin permisos para ejecutar código en la app.
	// El PDF va sin sandbox porque Chrome no muestra su visor de PDF dentro de un documento con sandbox.
	if (v.mime !== 'application/pdf' || !enLinea) h.set('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
	const r = rango(request.headers.get('range'), v.tamano);
	if (r === 'invalido') { h.set('content-range', `bytes */${v.tamano}`); return new Response(null, { status: 416, headers: h }); }
	const inicio = r ? r.inicio : 0, fin = r ? r.fin : v.tamano - 1;
	h.set('content-length', String(fin - inicio + 1));
	if (r) h.set('content-range', `bytes ${inicio}-${fin}/${v.tamano}`);
	if (request.method === 'HEAD') return new Response(null, { status: r ? 206 : 200, headers: h });
	const obj = await env.ENTREGAS.get(v.r2Key, r ? { range: { offset: inicio, length: fin - inicio + 1 } } : undefined);
	if (!obj) return error(404, 'El archivo ya no está en el almacenamiento');
	h.set('etag', obj.httpEtag);
	return new Response(obj.body, { status: r ? 206 : 200, headers: h });
}

// ---------- borrado: primero lógico (papelera), luego definitivo con confirmación ----------
async function entregaPara(env, id) {
	return typeof id === 'string' && ID_OK.test(id) ? leerEntidad(env, 'entrega', id) : null;
}

async function borrar(request, env, usuario, restaurar) {
	const b = await leerJson(request);
	const e = await entregaPara(env, b.id);
	if (!e || !e.datos) return error(404, 'Esa entrega no existe');
	if (!puedeBorrar(usuario, e.datos)) return error(403, 'Solo Dirección o quien creó la entrega puede borrarla');
	let cambio = false;
	const nueva = await guardarDelServidor(env, 'entrega', b.id, (actual) => {
		if (!actual || !!actual.borrada === !restaurar) return undefined; // ya estaba así
		cambio = true;
		const x = { ...actual };
		if (restaurar) delete x.borrada; else x.borrada = { por: usuario.id, en: ahora() };
		return x;
	}, usuario.id);
	if (cambio) await registrarActividad(env, usuario.id, restaurar ? 'restauró' : 'mandó a la papelera', nueva);
	return resp({ entrega: nueva });
}

async function purgar(request, env, usuario) {
	const b = await leerJson(request);
	if (b.confirmar !== 'BORRAR') return error(400, 'Para borrar el archivo para siempre escribe BORRAR');
	const e = await entregaPara(env, b.id);
	if (!e || !e.datos) return error(404, 'Esa entrega no existe');
	if (!puedeBorrar(usuario, e.datos)) return error(403, 'Solo Dirección o quien creó la entrega puede borrarla');
	if (!e.datos.borrada) return error(409, 'Primero manda la entrega a la papelera');
	const versiones = e.datos.versiones || [];
	const llaves = versiones.map((v) => v.r2Key);
	// Subidas de versiones nuevas que hubieran quedado a medias.
	const pend = (await env.DB.prepare('SELECT id, r2_key, upload_id FROM subidas WHERE entrega_id = ?1').bind(b.id).all()).results || [];
	for (const s of pend) {
		try { if (s.upload_id) await env.ENTREGAS.resumeMultipartUpload(s.r2_key, s.upload_id).abort(); } catch { /* ya cerrada */ }
		await limpiarSubida(env, s.id);
	}
	if (llaves.length) await env.ENTREGAS.delete(llaves);
	await guardarDelServidor(env, 'entrega', b.id, () => null, usuario.id);
	const mb = versiones.reduce((a, v) => a + v.tamano, 0) / 1e6;
	await registrarActividad(env, usuario.id, 'borró definitivamente', e.datos,
		`${versiones.length} ${versiones.length === 1 ? 'versión' : 'versiones'}, ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB liberados`);
	return resp({ ok: true });
}

// ---------- rutas ----------
export async function manejarEntregas(request, env, ruta, usuario) {
	if (!env.ENTREGAS) return error(500, 'Falta el almacenamiento de archivos (binding ENTREGAS)');
	const url = new URL(request.url), m = request.method;
	if (ruta === 'config' && m === 'GET') {
		return resp({ maxBytes: maxBytes(env), extensiones: Object.keys(TIPOS_ARCHIVO), tipos: TIPOS_ARCHIVO, vistaPrevia: [...VISTA_PREVIA] });
	}
	if (ruta === 'iniciar' && m === 'POST') return iniciar(request, env, usuario);
	if (ruta === 'parte' && m === 'PUT') return subirParte(request, env, usuario, url);
	if (ruta === 'completar' && m === 'POST') return completar(request, env, usuario);
	if (ruta === 'abortar' && m === 'POST') return abortar(request, env, usuario);
	if (ruta === 'archivo' && (m === 'GET' || m === 'HEAD')) return archivo(request, env, url);
	if (ruta === 'borrar' && m === 'POST') return borrar(request, env, usuario, false);
	if (ruta === 'restaurar' && m === 'POST') return borrar(request, env, usuario, true);
	if (ruta === 'purgar' && m === 'POST') return purgar(request, env, usuario);
	if (ruta === 'decidir' && m === 'POST') return decidir(request, env, usuario);
	return error(404, 'Ruta no encontrada');
}
