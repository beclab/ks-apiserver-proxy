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

const {
	getCurrentUser,
	getK8sRuntime,
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
} = require('../services/session');
const {
	setUserInfo,
	getUserInfo,
	isAdmin,
	isShared,
	namespaceFormat
} = require('../cache/user.js');

const {
	getServerConfig,
	getManifest,
	getLocaleManifest,
	isValidReferer,
	safeBase64
} = require('../libs/utils');
const { find, cloneDeep, get } = require('lodash');
const { collapseSplitSeries } = require('../libs/monitoring');

const { client: clientConfig } = getServerConfig();

const userDetail = async (ctx) => {
	const clusterRole = await getClusterRole(ctx);

	const [user, runtime, gitopsEngine] = await Promise.all([
		getCurrentUser(ctx, clusterRole, false),
		getK8sRuntime(ctx),
		getGitOpsEngine(ctx)
	]);

	const localeManifest = getLocaleManifest();
	const systemNamespaces = getSystemNamespaces()

	const data = {
		localeManifest,
		user,
		runtime,
		clusterRole,
		systemNamespaces
	};

	ctx.body = data;
};

const appList = async (ctx) => {
	const data = await getMyApps(ctx);
	ctx.body = data;
};

const systemIFS = async (ctx) => {
	const data = await getSystemIFS(ctx);
	ctx.body = data;
};

const monitoringDataFormat = (data, splitStr) => {
	return data.results.map((item) => ({
		...item,
		metric_name: item.metric_name.replace(splitStr, 'cluster_')
	}));
};

const toTimestampValueMap = (values) => {
	const map = {};
	if (Array.isArray(values)) {
		values.forEach((point) => {
			if (Array.isArray(point) && point.length >= 2) {
				map[point[0]] = Number(point[1]);
			}
		});
	}
	return map;
};

// Compute usage/total utilisation safely. The total series (denominator) may
// be missing data points or have a different length than the usage series
// (e.g. a user's quota vs. usage), so we align by timestamp and fall back to 0
// when the matching total is absent or zero instead of indexing blindly.
const calcUtilisation = (usageValues, totalTarget, isValues) => {
	if (isValues) {
		const totalMap = toTimestampValueMap(totalTarget);
		return (Array.isArray(usageValues) ? usageValues : []).map((point) => {
			const total = totalMap[point[0]];
			const ratio = total ? Number(point[1]) / total : 0;
			return [point[0], ratio];
		});
	}

	const total = Array.isArray(totalTarget) ? Number(totalTarget[1]) : 0;
	const ratio =
		Array.isArray(usageValues) && total ? Number(usageValues[1]) / total : 0;
	return [usageValues ? usageValues[0] : undefined, ratio];
};

// Build a `*_utilisation` metric from an existing usage metric and a total
// divisor. Returns null when the usage metric (or its data) is missing so the
// caller can simply skip it instead of crashing on an absent series.
const buildUtilisation = (
	list,
	usageMetricName,
	utilisationName,
	totalTarget,
	valueName,
	isValues
) => {
	const usageMetric = cloneDeep(find(list, { metric_name: usageMetricName }));
	const usageValue = get(usageMetric, ['data', 'result', 0, valueName]);
	if (usageValue === undefined) {
		return null;
	}
	usageMetric.data.result[0][valueName] = calcUtilisation(
		usageValue,
		totalTarget,
		isValues
	);
	return { ...usageMetric, metric_name: utilisationName };
};

const monitoringMetric = async (ctx) => {
	const queryParams = ctx.query;
	let params = {
		...queryParams
		// start: 1704418852,
		// end: 1704448852,
		// step: '300s',
		// times: 100,
	};

	const type = ctx.params.type;
	let data = { results: [] };
	let list = [];

	let clusterSplitStr = 'cluster_';
	let userSplitStr = 'user_';

	let cluster_cpu_total_target = {};
	let cluster_memory_total_target = {};
	const checkAdmin = isAdmin(ctx);
	if (type === 'cluster') {
		params.metrics_filter =
			'cluster_cpu_usage|cluster_cpu_total|cluster_cpu_utilisation|cluster_memory_usage_wo_cache|cluster_memory_total|cluster_memory_utilisation|cluster_disk_size_usage|cluster_disk_size_capacity|cluster_disk_size_utilisation|cluster_pod_running_count|cluster_pod_quota$';
		data = await getAllMetric(ctx, params);
		list = monitoringDataFormat(data, clusterSplitStr);
	} else {
		params.metrics_filter =
			'user_cpu_usage|user_cpu_total|user_cpu_utilisation|user_memory_usage_wo_cache|user_memory_total|user_memory_utilisation|user_disk_size_usage|user_disk_size_capacity|user_disk_size_utilisation|user_pod_running_count|user_pod_count$';

		const isValues = queryParams.start && queryParams.end;
		let valueName = 'values';
		if (!isValues) {
			valueName = 'value';
		}

		if (checkAdmin) {
			// Admin path: original logic, untouched. Cluster-level totals come from
			// `sum(...)` (a single, complete series), so positional division is safe.
			const clusterParams = {
				...params,
				metrics_filter:
					'cluster_cpu_total|cluster_memory_total|cluster_disk_size_capacity$'
			};
			const [clusterData, userData] = await Promise.all([
				getClusterMetric(ctx, clusterParams),
				getUserMetric(ctx, params)
			]);

			const clusterDataNew = monitoringDataFormat(clusterData, clusterSplitStr);
			list = monitoringDataFormat(userData, userSplitStr).map((item) => {
				let target = {};
				if (item.metric_name === 'cluster_cpu_total') {
					target = clusterDataNew.find(
						(child) => child.metric_name === 'cluster_cpu_total'
					);
					item.data.result[0][valueName] = target.data.result[0][valueName];
					cluster_cpu_total_target = item.data.result[0][valueName];
				} else if (item.metric_name === 'cluster_memory_total') {
					target = clusterDataNew.find(
						(child) => child.metric_name === 'cluster_memory_total'
					);
					item.data.result[0][valueName] = target.data.result[0][valueName];
					cluster_memory_total_target = item.data.result[0][valueName];
				}
				if (item.metric_name === 'cluster_pod_count') {
					item.metric_name = 'cluster_pod_quota';
				}
				return item;
			});

			const cluster_cpu_utilisation = cloneDeep(
				find(list, { metric_name: 'cluster_cpu_usage' })
			);
			const cluster_cpu_utilisation_value =
				cluster_cpu_utilisation.data.result[0][valueName];
			cluster_cpu_utilisation.data.result[0][valueName] = isValues
				? cluster_cpu_utilisation_value.map((item, index) => [
					item[0],
					item[1] / cluster_cpu_total_target[index][1]
				])
				: [
					cluster_cpu_utilisation_value[0],
					cluster_cpu_utilisation_value[1] / cluster_cpu_total_target[1]
				];

			const cluster_memory_utilisation = cloneDeep(
				find(list, { metric_name: 'cluster_memory_usage_wo_cache' })
			);
			const cluster_memory_utilisation_value =
				cluster_memory_utilisation.data.result[0][valueName];
			cluster_memory_utilisation.data.result[0][valueName] = isValues
				? cluster_memory_utilisation_value.map((item, index) => [
					item[0],
					item[1] / cluster_memory_total_target[index][1]
				])
				: [
					cluster_memory_utilisation_value[0],
					cluster_memory_utilisation_value[1] / cluster_memory_total_target[1]
				];

			list = list.concat([
				{ ...cluster_cpu_utilisation, metric_name: 'cluster_cpu_utilisation' },
				{
					...cluster_memory_utilisation,
					metric_name: 'cluster_memory_utilisation'
				}
			]);
		} else {
			// Sub-account path: no permission for cluster metrics, and the user's own
			// quota series can be split across kube-state-metrics instances. Fetch only
			// the user metric, collapse instance-split series, then compute utilisation
			// by timestamp with guards so a partial/missing series never crashes.
			const userData = collapseSplitSeries(await getUserMetric(ctx, params));

			list = monitoringDataFormat(userData, userSplitStr).map((item) => {
				if (item.metric_name === 'cluster_cpu_total') {
					cluster_cpu_total_target = get(item, ['data', 'result', 0, valueName]);
				} else if (item.metric_name === 'cluster_memory_total') {
					cluster_memory_total_target = get(item, [
						'data',
						'result',
						0,
						valueName
					]);
				}
				if (item.metric_name === 'cluster_pod_count') {
					item.metric_name = 'cluster_pod_quota';
				}
				return item;
			});

			const utilisations = [
				buildUtilisation(
					list,
					'cluster_cpu_usage',
					'cluster_cpu_utilisation',
					cluster_cpu_total_target,
					valueName,
					isValues
				),
				buildUtilisation(
					list,
					'cluster_memory_usage_wo_cache',
					'cluster_memory_utilisation',
					cluster_memory_total_target,
					valueName,
					isValues
				)
			].filter(Boolean);

			list = list.concat(utilisations);
		}
	}

	ctx.body = { results: list };
};

function endsWith(str, name) {
	const regex = new RegExp(`-${name}$`);
	return regex.test(str);
}

function buildNamespaceGroupBuckets(items, usersData) {
	const shared = [];
	const system = [];
	const userBuckets = new Map(usersData.map((u) => [u.name, []]));

	for (const namespace of items) {
		const name = namespace.metadata.name;
		if (isShared(namespace)) {
			shared.push(namespace);
			continue;
		}
		let matchedUser = false;
		for (const u of usersData) {
			if (endsWith(name, u.name)) {
				userBuckets.get(u.name).push(namespace);
				matchedUser = true;
			}
		}
		if (!matchedUser) {
			system.push(namespace);
		}
	}

	return { userBuckets, shared, system };
}

const namespaceGroup = async (ctx) => {
	const namespaces = await getNamespaces(ctx);
	const users = await getUsers(ctx);

	const originalData = namespaceFormat(ctx.req, namespaces);

	const SYSTEM = 'System';
	const SHARED = 'Shared';
	const usersData = users.items.map((item) => ({
		name: item.metadata.name,
		creation_timestamp: item.metadata.creationTimestamp
	}));

	let adminUser;
	let otherUsers;
	if (usersData.length > 0) {
		otherUsers = usersData.slice(0, -1);
		adminUser = usersData[usersData.length - 1];
	} else {
		otherUsers = [];
	}
	const usersOrderedForBuckets = adminUser
		? [adminUser, ...otherUsers]
		: [];

	const { userBuckets, shared, system } = buildNamespaceGroupBuckets(
		originalData.items,
		usersOrderedForBuckets
	);

	const checkAdmin = isAdmin(ctx);

	const result = [
		...(adminUser
			? [
				{
					title: adminUser.name,
					data: userBuckets.get(adminUser.name)
				}
			]
			: []),
		...otherUsers.map((u) => ({
			title: u.name,
			data: userBuckets.get(u.name)
		})),
		...(checkAdmin
			? [
				{ title: SHARED, data: shared },
				{ title: SYSTEM, data: system }
			]
			: [])
	];

	ctx.body = result.filter((item) => item.data.length > 0);
};

const cacheUser = async (ctx, next) => {
	const user = getUserInfo(ctx);
	if (!user) {
		const clusterRole = await getClusterRole(ctx);
		const [user] = await Promise.all([
			getCurrentUser(ctx, clusterRole)
		]);

		setUserInfo(ctx, user);
	}
	await next();
};

const renderIndex = async (ctx, params) => {
	const manifest = getManifest('main');
	const localeManifest = getLocaleManifest();

	await ctx.render('index', {
		manifest,
		isDev: global.MODE_DEV,
		title: clientConfig.title,
		hostname: ctx.hostname,
		globals: JSON.stringify({
			config: clientConfig,
			localeManifest,
			...params
		})
	});
};

module.exports = {
	userDetail,
	cacheUser,
	appList,
	systemIFS,
	monitoringMetric,
	namespaceGroup
};
