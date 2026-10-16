// Centro Eureka Hub: Worker principal. Sirve public/ y las rutas /api.
import { manejarApi } from './api.js';
import { respaldar } from './respaldo.js';
import { vaciarPapeleraNotas } from './limpieza.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return manejarApi(request, env, ctx);
		return env.ASSETS.fetch(request);
	},
	// Cada día a las 09:00 UTC = 3:00 a. m. en Guadalajara (cron de wrangler.jsonc): respaldo (F5) y, después,
	// vaciar la papelera de la pizarra (notas con 7 días o más). El respaldo va primero para que las incluya.
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(respaldar(env, { origen: 'cron' }).then(() => vaciarPapeleraNotas(env)));
	},
};
