/** 字节数转人话（日志与提示里用） */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 毫秒转人话（同步耗时） */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} 毫秒`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

/** 时间戳转「2026-10-04 14:30」 */
export function formatTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 时间戳转文件名能用的「20261004-143022」（不能带冒号：Windows 文件名不允许） */
export function formatStamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
