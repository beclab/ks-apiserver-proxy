/*
 * Shared helpers for KubeSphere monitoring responses.
 *
 * Quota metrics that originate from kube-state-metrics (e.g. kube_user_cpu_total)
 * carry per-target labels such as `instance`. When a KSM Pod restarts or is
 * rescheduled, the `instance` label changes, so a single logical series is split
 * into several `result` entries that each cover only part of the time window.
 *
 * Consumers that only read `result[0]` then see an incomplete/stale series:
 * the displayed total goes blank, and any usage/total calculation that indexes
 * by position can mismatch or crash. `collapseSplitSeries` merges series that are
 * identical apart from volatile per-target labels back into one complete series.
 */

// Labels that identify a scrape target rather than the logical metric. Series
// that differ only by these are the same quantity and should be merged.
const VOLATILE_LABELS = ['instance', 'pod', 'container', 'endpoint', 'uid', 'job'];

const stripVolatileLabels = (metric) => {
	const cleaned = { ...(metric || {}) };
	VOLATILE_LABELS.forEach((label) => delete cleaned[label]);
	return cleaned;
};

const seriesIdentity = (metric) => {
	const cleaned = stripVolatileLabels(metric);
	return JSON.stringify(
		Object.keys(cleaned)
			.sort()
			.reduce((acc, key) => {
				acc[key] = cleaned[key];
				return acc;
			}, {})
	);
};

// Merge a group of series (same logical identity) into one. Range data (`values`)
// is unioned by timestamp; instant data (`value`) keeps the most recent sample.
const mergeSeriesGroup = (seriesList) => {
	const base = seriesList[0];
	const merged = { ...base, metric: stripVolatileLabels(base.metric) };

	if (seriesList.some((series) => Array.isArray(series.values))) {
		const byTimestamp = {};
		seriesList.forEach((series) => {
			if (Array.isArray(series.values)) {
				series.values.forEach((point) => {
					if (Array.isArray(point) && point.length >= 2) {
						byTimestamp[point[0]] = point[1];
					}
				});
			}
		});
		merged.values = Object.keys(byTimestamp)
			.map((ts) => [Number(ts), byTimestamp[ts]])
			.sort((a, b) => a[0] - b[0]);
	}

	if (seriesList.some((series) => Array.isArray(series.value))) {
		const latest = seriesList
			.map((series) => series.value)
			.filter((value) => Array.isArray(value) && value.length >= 2)
			.sort((a, b) => Number(a[0]) - Number(b[0]))
			.pop();
		if (latest) {
			merged.value = latest;
		}
	}

	return merged;
};

const collapseMetricSeries = (metric) => {
	const result = metric && metric.data && metric.data.result;
	if (!Array.isArray(result) || result.length <= 1) {
		return metric;
	}

	const groups = new Map();
	result.forEach((series) => {
		const id = seriesIdentity(series && series.metric);
		if (!groups.has(id)) {
			groups.set(id, []);
		}
		groups.get(id).push(series);
	});

	const newResult = [];
	groups.forEach((seriesList) => {
		newResult.push(
			seriesList.length === 1 ? seriesList[0] : mergeSeriesGroup(seriesList)
		);
	});

	return {
		...metric,
		data: {
			...metric.data,
			result: newResult
		}
	};
};

/**
 * Collapse instance-split series in a KubeSphere monitoring payload.
 * Accepts both the wire shape `{ results: [...] }` and a bare metric array,
 * returning the same shape it was given. Unknown shapes pass through untouched.
 */
const collapseSplitSeries = (payload) => {
	if (Array.isArray(payload)) {
		return payload.map(collapseMetricSeries);
	}
	if (payload && Array.isArray(payload.results)) {
		return { ...payload, results: payload.results.map(collapseMetricSeries) };
	}
	return payload;
};

module.exports = {
	collapseSplitSeries
};
