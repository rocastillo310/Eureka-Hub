// Ayudas para los scripts: consultas y archivos SQL contra D1 con el wrangler del proyecto (local o producción).
import { execFileSync } from 'node:child_process';

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';

export function d1(remoto) {
	const donde = remoto ? '--remote' : '--local';
	const correr = (args, opciones = {}) => execFileSync(process.execPath, [WRANGLER, 'd1', ...args], { maxBuffer: 1024 * 1024 * 1024, ...opciones });
	return {
		consultar(sql) {
			const salida = correr(['execute', 'eureka-hub-db', donde, '--json', '--command', sql], { stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8');
			const r = JSON.parse(salida.slice(salida.indexOf('[')));
			return r[0].results || [];
		},
		ejecutarArchivo(ruta) {
			correr(['execute', 'eureka-hub-db', donde, `--file=${ruta}`, '--yes'], { stdio: 'inherit' });
		},
	};
}
