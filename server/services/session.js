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

const get = require('lodash/get');
const uniq = require('lodash/uniq');
const isEmpty = require('lodash/isEmpty');
const isArray = require('lodash/isArray');
const jwtDecode = require('jwt-decode');
const { ownerToGlobalRole } = require('../cache/user.config');

const { send_gateway_request, send_gateway_request_system } = require('../libs/request');

const {
	isAppsRoute,
	safeParseJSON,
	getServerConfig
} = require('../libs/utils');

const { server: serverConfig } = getServerConfig();

const handleLoginResp = (resp = {}) => {
	if (!resp.access_token) {
		throw new Error(resp.message);
	}

	const { access_token, refresh_token, expires_in } = resp || {};

	const { username, extra, groups } = jwtDecode(access_token);
	const email = get(extra, 'email[0]');
	const initialized = get(extra, 'uninitialized[0]') !== 'true';
	const extraname = get(extra, 'username[0]') || get(extra, 'uid[0]');

	return {
		username,
		email,
		groups,
		extraname,
		initialized,
		token: access_token,
		refreshToken: refresh_token,
		expire: new Date().getTime() + Number(expires_in) * 1000
	};
};

const login = async (data, headers) => {
	let clientID = serverConfig.apiServer.clientID;
	if (!clientID) {
		clientID = 'kubesphere';
	}

	let clientSecret = serverConfig.apiServer.clientSecret;
	if (!clientSecret) {
		clientSecret = 'kubesphere';
	}

	data.client_id = clientID;
	data.client_secret = clientSecret;

	const resp = await send_gateway_request({
		method: 'POST',
		url: '/oauth/token',
		headers: {
			...headers,
			'content-type': 'application/x-www-form-urlencoded'
		},
		params: {
			...data,
			grant_type: 'password'
		}
	});

	return handleLoginResp(resp);
};

const getNewToken = async (ctx) => {
	const refreshToken = ctx.cookies.get('auth_refresh_token');
	let newToken = {};

	const data = {
		grant_type: 'refresh_token',
		refresh_token: refreshToken
	};

	let clientID = serverConfig.apiServer.clientID;
	if (!clientID) {
		clientID = 'kubesphere';
	}

	let clientSecret = serverConfig.apiServer.clientSecret;
	if (!clientSecret) {
		clientSecret = 'kubesphere';
	}

	data.client_id = clientID;
	data.client_secret = clientSecret;

	const resp = await send_gateway_request({
		method: 'POST',
		url: '/oauth/token',
		headers: {
			'content-type': 'application/x-www-form-urlencoded'
		},
		params: data,
		token: refreshToken
	});

	const { access_token, refresh_token, expires_in } = resp || {};

	if (!access_token) {
		throw new Error(resp.message);
	}

	newToken = {
		token: access_token,
		refreshToken: refresh_token,
		expire: new Date().getTime() + Number(expires_in) * 1000
	};

	return newToken;
};

const oAuthLogin = async ({ oauthName, ...params }) => {
	const resp = await send_gateway_request({
		method: 'GET',
		url: `/oauth/callback/${oauthName}`,
		params
	});

	return handleLoginResp(resp);
};

const getUserGlobalRules = async (username, token) => {
	const resp = await send_gateway_request({
		method: 'GET',
		url: `/kapis/iam.kubesphere.io/v1alpha2/users/${username}/globalroles`,
		token
	});

	const rules = {};
	resp.forEach((item) => {
		const rule = safeParseJSON(
			get(
				item,
				"metadata.annotations['iam.kubesphere.io/role-template-rules']"
			),
			{}
		);

		Object.keys(rule).forEach((key) => {
			rules[key] = rules[key] || [];
			if (isArray(rule[key])) {
				rules[key].push(...rule[key]);
			} else {
				rules[key].push(rule[key]);
			}
			rules[key] = uniq(rules[key]);
		});
	});

	return rules;
};

const getUserDetail = async (token, clusterRole, isMulticluster) => {
	let user = {};

	const { username } = jwtDecode(token);

	const resp = await send_gateway_request({
		method: 'GET',
		url: `/kapis/iam.kubesphere.io/v1alpha2/users/${username}`,
		token
	});
	const ownerRole = get(
		resp,
		'metadata.annotations["bytetrade.io/owner-role"]'
	)
	console.log('ownerToGlobalRole', ownerToGlobalRole)

	const globalrole = ownerToGlobalRole(ownerRole);

	if (resp) {
		user = {
			email: get(resp, 'spec.email'),
			lang: get(resp, 'spec.lang'),
			username: get(resp, 'metadata.name'),
			globalrole,
			grantedClusters: get(
				resp,
				'metadata.annotations["iam.kubesphere.io/granted-clusters"]',
				[]
			),
			lastLoginTime: get(resp, 'status.lastLoginTime')
		};
	} else {
		throw new Error(resp);
	}

	try {
		const roles = await getUserGlobalRules(username, token);

		if (clusterRole === 'member') {
			roles.users = roles.users.filter((role) => role !== 'manage');
			roles.workspaces = roles.workspaces.filter((role) => role !== 'manage');
		}

		const isClustersRole = Object.keys(roles).includes('clusters');

		if (
			!isClustersRole &&
			user.grantedClusters.length > 0 &&
			isMulticluster === true
		) {
			roles.clusters = ['view'];
		}

		user.globalRules = roles;
	} catch (error) { }

	return user;
};


const getKSConfig = async (ctx) => {
	const token = ctx.cookies.get('auth_token');
	let resp = {};
	try {
		const [config, version] = await Promise.all([
			send_gateway_request({
				method: 'GET',
				url: '/kapis/config.kubesphere.io/v1alpha2/configs/configz',
				token
			}),
			send_gateway_request({
				method: 'GET',
				url: '/kapis/version',
				token
			})
		]);
		resp = { ...config };
		if (version) {
			resp.ksVersion = version.gitVersion;
		}
	} catch (error) {
		console.error(error);
	}

	return resp;
};

const getK8sRuntime = async (ctx) => {
	const token = ctx.cookies.get('auth_token');
	let resp = 'docker';
	if (!token) {
		return resp;
	}
	try {
		const nodeList = await send_gateway_request({
			method: 'GET',
			url: '/api/v1/nodes',
			token
		});
		if (nodeList.items) {
			const runTime = nodeList.items[0].status.nodeInfo.containerRuntimeVersion;
			resp = runTime.split(':')[0];
		}
	} catch (error) {
		console.error(error);
	}

	return resp;
};

const getClusterRole = async (ctx) => {
	const token = ctx.cookies.get('auth_token');
	let role = 'host';
	if (!token) {
		return role;
	}
	try {
		const config = await send_gateway_request({
			method: 'GET',
			url: '/api/v1/namespaces/kubesphere-system/configmaps/kubesphere-config',
			token
		});
		const data = config.data['kubesphere.yaml'];
		const str = /clusterRole:(\s*[\w]+\s*)/g.exec(data);

		if (str && Array.isArray(str)) {
			const clusterRole = str[0].split(':')[1].replace(/\s/g, '');
			role =
				['host', 'member'].indexOf(clusterRole) === -1 ? 'host' : clusterRole;
		}
	} catch (error) {
		console.error(error);
	}

	return role;
};

const getMyApps = async (ctx) => {
	const token = ctx.cookies.get('auth_token');
	const data = await send_gateway_request({
		method: 'GET',
		url: '/bfl/app_process/v1alpha1/myapps',
		headers: {
			'X-Authorization': token
		}
	});
	return data.data;
};

const getSystemIFS = async (ctx) => {
	const params = ctx.query || {};
	const data = await send_gateway_request_system({
		method: 'GET',
		url: '/system/ifs',
		headers: {
			'X-Signature': 'did jws'
		},
		params
	});
	console.log('getSystemIFS', data)
	return data.data;
};


const getClusterMetric = async (ctx, params) => {
	const token = ctx.cookies.get('auth_token');
	return await send_gateway_request({
		method: 'GET',
		url: '/kapis/monitoring.kubesphere.io/v1alpha3/cluster',
		params,
		token
	});
};

const getAllMetric = async (ctx, params) => {
	const data = await getClusterMetric(ctx, params);
	return data;
};

const getUserMetric = async (ctx, params) => {
	const token = ctx.cookies.get('auth_token');
	const user = ctx.params.type;

	const data = await send_gateway_request({
		method: 'GET',
		url: `/kapis/monitoring.kubesphere.io/v1alpha3/users/${user}`,
		params,
		token
	});

	return data;
};


// TODO: need to get the data from kubesphere
const getGitOpsEngine = async (ctx) => {
	const token = ctx.cookies.get('auth_token');
	if (!token) {
		return [];
	}
	return 'argocd';
};

const getNamespaces = async (ctx) => {
	const token = ctx.cookies.get('auth_token');

	const resp = await send_gateway_request({
		method: 'GET',
		url: `/kapis/resources.kubesphere.io/v1alpha3/namespaces`,
		params: {
			sortBy: 'createTime',
			labelSelector: 'kubesphere.io/workspace!=kubesphere.io/devopsproject'
		},
		token
	});
	return resp;

}

const getUsers = async (ctx, clusterRole, isMulticluster) => {
	const token = ctx.cookies.get('auth_token');

	const resp = await send_gateway_request({
		method: 'GET',
		url: `/kapis/iam.kubesphere.io/v1alpha2/users`,
		token
	});
	return resp;
};

const getCurrentUser = async (ctx, clusterRole, isMulticluster = false) => {
	const token = ctx.cookies.get('auth_token');

	if (!token) {
		if (isAppsRoute(ctx.path)) {
			return null;
		}
		ctx.throw(401, 'Not Login');
	}

	const [userDetail, workspaces] = await Promise.all([
		getUserDetail(token, clusterRole, isMulticluster),
	]);

	return { ...userDetail, workspaces };
};


const createUser = (params, token) => {
	return send_gateway_request({
		method: 'POST',
		url: '/kapis/iam.kubesphere.io/v1alpha2/users',
		params: {
			apiVersion: 'iam.kubesphere.io/v1alpha2',
			kind: 'User',
			metadata: {
				name: params.username
			},
			spec: {
				email: params.email
			}
		},
		token
	});
};

const getSystemNamespaces = () => [
	'os-platform',
	'os-network',
	'os-framework',
	'os-gpu',
	'kubesphere-monitoring-federated',
	'kubesphere-controls-system',
	'kubesphere-system',
	'kubesphere-monitoring-system',
	'kubekey-system',
	'kube-system',
	'kube-public',
	'kube-node-lease',
	'default',
	]

module.exports = {
	login,
	oAuthLogin,
	getCurrentUser,
	getNewToken,
	getKSConfig,
	getK8sRuntime,
	createUser,
	getClusterRole,
	getGitOpsEngine,
	getMyApps,
	getSystemIFS,
	getAllMetric,
	getUserMetric,
	getClusterMetric,
	getUsers,
	getNamespaces,
	getSystemNamespaces
};
