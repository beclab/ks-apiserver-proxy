const { URL } = require('url');

const { patchMonitoringNamespacesPostBody } = require('../cache/user');

const MONITORING_NAMESPACES = '/kapis/monitoring.kubesphere.io/v1alpha3/namespaces';
const MAX_BODY = 10 * 1024 * 1024;


module.exports = async function kapisMonitoringNamespacesPost(ctx, next) {
	if (ctx.path !== MONITORING_NAMESPACES || ctx.method !== 'POST') {
		return next();
	}

	const ct = (ctx.headers['content-type'] || '').toLowerCase();
	if (!ct.includes('application/json')) {
		return next();
	}

	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		size += chunk.length;
		if (size > MAX_BODY) {
			ctx.status = 413;
			ctx.body = { message: 'Payload too large' };
			return;
		}
		chunks.push(chunk);
	}

	const buf = Buffer.concat(chunks);
	let json = {};
	if (buf.length) {
		try {
			json = JSON.parse(buf.toString('utf8'));
		} catch (e) {
			ctx.status = 400;
			ctx.body = { message: 'Invalid JSON body' };
			return;
		}
	}

	const search = new URL(ctx.url, 'http://localhost').search.slice(1);
	ctx.req.kapisMonitoringJsonBody = json;

	const outObj = patchMonitoringNamespacesPostBody(ctx, json, search);
	const outBuf = Buffer.from(JSON.stringify(outObj), 'utf8');
	ctx.req.rawBody = outBuf;
	ctx.req.headers['content-length'] = String(outBuf.length);
	delete ctx.req.headers['transfer-encoding'];

	await next();
};
