// Centro Eureka Hub: Worker principal. Sirve public/ y las rutas /api.
import { manejarApi } from './api.js';
import { respaldar } from './respaldo.js';
import { vaciarPapeleraNotas } from './limpieza.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return manejarApi(request, env, ctx);
		// La API desde el panel: /admin/api/* la cubre la aplicación de Access del panel, cuyo JWT tiene otra audiencia
		// (ACCESS_AUD_ADMIN). Mismas rutas y los mismos permisos por nivel.
		if (url.pathname.startsWith('/admin/api/')) {
			const interna = new URL(url);
			interna.pathname = url.pathname.slice('/admin'.length);
			const aud = (env.ACCESS_AUD_ADMIN || '').trim();
			return manejarApi(new Request(interna, request), { ...env, ACCESS_AUD: aud || 'falta-configurar-ACCESS_AUD_ADMIN' }, ctx);
		}
		// Panel de administración: la misma app (abre en la vista del panel). Cloudflare Access protege /admin con su
		// propia política (solo Administración) y el servidor vuelve a revisar el nivel en cada cambio.
		if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return env.ASSETS.fetch(new Request(new URL('/', url), request));
		return env.ASSETS.fetch(request);
	},
	// Cada día a las 09:00 UTC = 3:00 a. m. en Guadalajara (cron de wrangler.jsonc): respaldo (F5) y, después,
	// vaciar la papelera de la pizarra (notas con 7 días o más). El respaldo va primero para que las incluya.
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(respaldar(env, { origen: 'cron' }).then(() => vaciarPapeleraNotas(env)));
	},
};
