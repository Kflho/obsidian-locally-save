/**
 * 拖放：把 `.lsave` 拖进对话框，等同于在输入框里粘路径。
 *
 * 这里测"从拖进来的文件里认出路径"这段纯逻辑 —— 两代取法（`File.path` /
 * Electron 32 的 `webUtils`）与各种挑剔的情况都在里面。
 */
import { pickBundleFromDrop, resolveDroppedPath } from "../src/ui/drop";

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

// -------------------------------------------------------------------- 用例
// 正常的包
check('认出 .lsave 的路径', pickBundleFromDrop([{ name: 'a.lsave', path: 'D:/传送/a.lsave' }]).path, 'D:/传送/a.lsave');
check('后缀大写也认', pickBundleFromDrop([{ name: 'A.LSAVE', path: '/tmp/A.LSAVE' }]).path, '/tmp/A.LSAVE');
check('多个文件时挑第一个 .lsave', pickBundleFromDrop([
	{ name: 'first.lsave', path: 'D:/first.lsave' },
	{ name: 'second.lsave', path: 'D:/second.lsave' },
]).path, 'D:/first.lsave');
check('包不在第一个也认得出来（拖了一堆文件进来）', pickBundleFromDrop([
	{ name: '随手拖的图片.png', path: 'D:/图.png' },
	{ name: '笔记.md', path: 'D:/笔记.md' },
	{ name: '我的笔记-changes-20261004.lsave', path: 'D:/包.lsave' },
]).path, 'D:/包.lsave');

// 挑剔的情况：每种都要给出人话的原因，而不是静默不动
const wrongType = pickBundleFromDrop([{ name: '笔记.zip', path: 'D:/笔记.zip' }]);
check('不是同步包 → 不给路径', wrongType.path, null);
checkTrue('并说明后缀要求', (wrongType.error ?? '').includes('.lsave'), wrongType.error ?? '');

const empty = pickBundleFromDrop([]);
check('没拖文件 → 不给路径', empty.path, null);
checkTrue('并提示拖一个包过来', (empty.error ?? '').includes('拖一个'), empty.error ?? '');

const noPath = pickBundleFromDrop([{ name: 'a.lsave' }]);
check('拿不到路径 → 不给路径', noPath.path, null);
checkTrue('并提示改用粘贴', (noPath.error ?? '').includes('粘贴'), noPath.error ?? '');

check('null 也不炸', pickBundleFromDrop(null).path, null);

// 路径的两代取法
check('优先用 File.path', resolveDroppedPath({ name: 'a.lsave', path: 'D:/a.lsave' }), 'D:/a.lsave');
check('空字符串当作没有', resolveDroppedPath({ name: 'a.lsave', path: '' }), null);
check('没有 File.path、也没有 electron 时返回 null', resolveDroppedPath({ name: 'a.lsave' }), null);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
