/*
 * This file is part of KubeSphere Console.
 * Copyright (C) 2019 The KubeSphere Console Authors.
 *
 * KubeSphere Console is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * KubeSphere Console is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with KubeSphere Console.  If not, see <https://www.gnu.org/licenses/>.
 */

const http = require('http');
const zlib = require('zlib');
const querystring = require('querystring');

const { getServerConfig } = require('./libs/utils');
const {
	checkUrl,
	canModify,
	isAdmin,
	mergeMonitoringNamespaceRequestParams
} = require('./cache/user');

const { server: serverConfig } = getServerConfig();

const NEED_OMIT_HEADERS = ['referer'];

const k8sResourceProxy = {
	target: serverConfig.apiServer.url,
	changeOrigin: true,
	events: {
		proxyReq(proxyReq, req, res, options) {
			const parsedUrl = new URL(req.url, 'http://locathost:3000');
			const { pathname, search } = parsedUrl;
			const target = checkUrl(pathname);
			if (target) {
				if (canModify(req, pathname)) {
					options.selfHandleResponse = true;
				}
				if (!isAdmin(req) && target.searchParamsFn) {
					const urlQuery = querystring.parse(parsedUrl.search.slice(1));
					const filterInput = mergeMonitoringNamespaceRequestParams(
						parsedUrl.search.slice(1),
						req.kapisMonitoringJsonBody
					);
					const newParams = {
						...urlQuery,
						...target.searchParamsFn(req, filterInput)
					};
					const modifiedUrl = `${pathname}?${querystring.stringify(newParams)}`;
					proxyReq.path = modifiedUrl;
				}
			}
			if (req.token) {
				proxyReq.setHeader('Authorization', `Bearer ${req.token}`);
			}

			NEED_OMIT_HEADERS.forEach((key) => proxyReq.removeHeader(key));
		},
		proxyRes: k8sResourceproxyRes
	}
};

const b2iFileProxy = {
	target: serverConfig.apiServer.url,
	changeOrigin: true,
	ignorePath: true,
	selfHandleResponse: true,
	optionsHandle(options, req) {
		options.target += `/${req.url.slice(14)}`;
	},
	events: {
		proxyReq(proxyReq, req) {
			proxyReq.setHeader('Authorization', `Bearer ${req.token}`);

			NEED_OMIT_HEADERS.forEach((key) => proxyReq.removeHeader(key));
		},
		proxyRes(proxyRes, req, client_res) {
			let body = [];
			proxyRes.on('data', (chunk) => {
				body.push(chunk);
			});
			proxyRes.on('end', () => {
				const redirectUrl = proxyRes.headers.location;
				if (!redirectUrl) {
					body = Buffer.concat(body).toString();
					client_res.writeHead(500, proxyRes.headers);
					client_res.end(body);
					console.error(`get b2i file failed, message: ${body}`);
				}
				const proxy = http.get(proxyRes.headers.location, (res) => {
					client_res.writeHead(res.statusCode, res.headers);
					res.pipe(client_res, { end: true });
				});
				client_res.pipe(proxy, { end: true });
			});
		}
	}
};

function modifyResponseBody(req, data, pathname) {
	const target = checkUrl(pathname);
	return target.resFormat(req, data);
}

function k8sResourceproxyRes(proxyRes, req, res) {
	const { pathname } = new URL(req.url, 'http://locathost:3000');

	// Only non-admin responses are rewritten; admin responses are piped through
	// untouched by the proxy. Returning here leaves the default passthrough.
	if (!canModify(req, pathname)) {
		return;
	}

	const isGzip = proxyRes.headers['content-encoding'] === 'gzip';
	const chunks = [];

	let finished = false;
	const finish = (rawBuffer) => {
		if (finished) {
			return;
		}
		finished = true;

		// Fallback: stream the original bytes back verbatim. Used whenever decoding
		// or rewriting fails so the request never hangs and the client still gets
		// the upstream payload. content-length is corrected to the real size.
		const passthrough = () => {
			const headers = { ...proxyRes.headers };
			if (rawBuffer) {
				headers['content-length'] = String(rawBuffer.length);
			}
			res.writeHead(proxyRes.statusCode, headers);
			res.end(rawBuffer || undefined);
		};

		if (!rawBuffer) {
			passthrough();
			return;
		}

		try {
			const decoded = isGzip ? zlib.gunzipSync(rawBuffer) : rawBuffer;
			const modified = modifyResponseBody(
				req,
				JSON.parse(decoded.toString('utf8')),
				pathname
			);
			let body = Buffer.from(JSON.stringify(modified), 'utf8');
			if (isGzip) {
				body = zlib.gzipSync(body);
			}
			const headers = { ...proxyRes.headers };
			headers['content-length'] = String(body.length);
			delete headers['transfer-encoding'];
			res.writeHead(proxyRes.statusCode, headers);
			res.end(body);
		} catch (error) {
			console.error('k8sResourceproxyRes rewrite failed, passing through:', error);
			passthrough();
		}
	};

	proxyRes.on('data', (chunk) => chunks.push(chunk));
	proxyRes.on('end', () => finish(Buffer.concat(chunks)));
	proxyRes.on('error', () => finish(chunks.length ? Buffer.concat(chunks) : null));
}

module.exports = {
	k8sResourceProxy,
	b2iFileProxy
};
