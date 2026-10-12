// Base D1 falsa para pruebas, sobre el SQLite que trae Node (node:sqlite). Imita solo lo que usa el servidor:
// prepare().bind().all()/first()/run() y batch() en una transacción. Aplica las migraciones reales de migrations/.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../migrations/', import.meta.url);

class Sentencia {
	constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
	bind(...args) { return new Sentencia(this.db, this.sql, args); }
	_ejecutar() {
		const st = this.db.prepare(this.sql);
		if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: st.all(...this.args), meta: { changes: 0 } };
		const r = st.run(...this.args);
		return { results: [], meta: { changes: Number(r.changes) } };
	}
	async all() { return this._ejecutar(); }
	async first() { const r = this._ejecutar(); return r.results[0] ?? null; }
	async run() { return this._ejecutar(); }
}

export function d1Falso() {
	const db = new DatabaseSync(':memory:');
	for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, DIR), 'utf8'));
	return {
		_db: db,
		prepare: (sql) => new Sentencia(db, sql),
		async batch(sentencias) {
			db.exec('BEGIN');
			try {
				const res = sentencias.map((s) => s._ejecutar());
				db.exec('COMMIT');
				return res;
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		},
	};
}
