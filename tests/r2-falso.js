// Bucket R2 falso para pruebas. Imita lo que usa el servidor y las reglas de multipart de R2 que importan:
// partes de al menos 5 MiB salvo la última, todas iguales salvo la última, y etags que deben coincidir al completar.
const MIN = 5 * 1024 * 1024;

async function aBytes(v) {
	if (v instanceof Uint8Array) return v;
	return new Uint8Array(await new Response(v).arrayBuffer());
}

export function r2Falso() {
	const objetos = new Map(), subidas = new Map();
	let n = 0;
	function mpu(key, uploadId) {
		const viva = () => {
			const s = subidas.get(uploadId);
			if (!s || s.key !== key) throw new Error('NoSuchUpload');
			return s;
		};
		return {
			key, uploadId,
			async uploadPart(num, valor) {
				const s = viva();
				const b = await aBytes(valor);
				const etag = `p${num}-${b.length}-${++n}`;
				s.partes.set(num, { b, etag });
				return { partNumber: num, etag };
			},
			async abort() { viva(); subidas.delete(uploadId); },
			async complete(lista) {
				const s = viva();
				const orden = [...lista].sort((a, z) => a.partNumber - z.partNumber);
				const trozos = orden.map((p) => {
					const x = s.partes.get(p.partNumber);
					if (!x || x.etag !== p.etag) throw new Error('InvalidPart');
					return x.b;
				});
				trozos.slice(0, -1).forEach((b) => {
					if (b.length < MIN) throw new Error('EntityTooSmall');
					if (b.length !== trozos[0].length) throw new Error('InvalidPart: partes de distinto tamaño');
				});
				const total = trozos.reduce((a, b) => a + b.length, 0), bytes = new Uint8Array(total);
				let o = 0;
				for (const b of trozos) { bytes.set(b, o); o += b.length; }
				objetos.set(key, { bytes, etag: `obj-${++n}`, tipo: s.op && s.op.httpMetadata && s.op.httpMetadata.contentType });
				subidas.delete(uploadId);
				return { key, size: total, httpEtag: `"obj-${n}"` };
			},
		};
	}
	return {
		_objetos: objetos, _subidas: subidas,
		async createMultipartUpload(key, op) {
			const uploadId = 'u' + ++n;
			subidas.set(uploadId, { key, op, partes: new Map() });
			return mpu(key, uploadId);
		},
		resumeMultipartUpload: (key, uploadId) => mpu(key, uploadId),
		async get(key, op) {
			const o = objetos.get(key);
			if (!o) return null;
			let b = o.bytes;
			if (op && op.range) b = b.slice(op.range.offset, op.range.offset + op.range.length);
			return { body: new Response(b).body, httpEtag: `"${o.etag}"`, size: o.bytes.length };
		},
		async delete(llaves) { for (const k of [].concat(llaves)) objetos.delete(k); },
		async list({ cursor, limit = 1000 } = {}) {
			const todas = [...objetos.keys()].sort(), desde = cursor ? Number(cursor) : 0, pagina = todas.slice(desde, desde + limit);
			const fin = desde + limit < todas.length;
			return { objects: pagina.map((k) => ({ key: k, size: objetos.get(k).bytes.length, etag: objetos.get(k).etag, uploaded: new Date('2026-10-13T00:00:00Z') })), truncated: fin, cursor: fin ? String(desde + limit) : undefined };
		},
	};
}
