/**
 * SSH 接入的**纯判断**：怎么算认证成功、远程地址里怎么取主机名。
 *
 * 起因（真机踩过）：GitHub 不提供 shell，`ssh -T git@github.com` 认证成功也返回**退出码 1**。
 * 如果按退出码判断，插件会永远显示"测试失败" —— 所以只看文本里的
 * `successfully authenticated` / `Welcome to`。这里把那条规则钉死。
 */
import { hostOfRemote, isSshRemote, sshAuthSucceeded } from '../src/ui/ssh';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

// 1. 认证成功的判定：**不看退出码，只看文本**
check(
	'GitHub 成功（退出码会是 1，也算成功）',
	sshAuthSucceeded("Hi Kflho! You've successfully authenticated, but GitHub does not provide shell access."),
	true,
);
check(
	'Gitee 的成功文案',
	sshAuthSucceeded("Hi someone! You've successfully authenticated, but GITEE.COM does not provide shell access."),
	true,
);
check('GitLab 的欢迎语', sshAuthSucceeded('Welcome to GitLab, @someone!'), true);
check('公钥被拒', sshAuthSucceeded('git@github.com: Permission denied (publickey).'), false);
check('主机指纹没确认', sshAuthSucceeded('Host key verification failed.'), false);
check('空输出', sshAuthSucceeded(''), false);

// 2. 从远程地址里取主机名
check('scp 形式', hostOfRemote('git@github.com:Kflho/obsidian-lsave-shelf-test.git'), 'github.com');
check('ssh:// 形式', hostOfRemote('ssh://git@github.com/Kflho/repo.git'), 'github.com');
check('https 形式', hostOfRemote('https://github.com/Kflho/repo.git'), 'github.com');
check('不认识的地址', hostOfRemote(''), null);

// 3. 是不是 SSH 地址（HTTPS 拿 SSH 密钥没用）
check('scp 形式是 SSH', isSshRemote('git@github.com:Kflho/repo.git'), true);
check('ssh:// 是 SSH', isSshRemote('ssh://git@github.com/Kflho/repo.git'), true);
check('https 不是 SSH', isSshRemote('https://github.com/Kflho/repo.git'), false);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
if (failures.length > 0) process.exitCode = 1;
