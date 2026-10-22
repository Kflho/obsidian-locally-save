import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				moment: 'readonly',
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'eslint.config.mts',
						'manifest.json',
					]
				},
				tsconfigRootDir: path.dirname(fileURLToPath(import.meta.url)),
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 濞村鐦禒锝囩垳鏉╂劘顢戦崷?Node 閻滎垰顣ㄩ敍灞肩瑬闂団偓鐟曚胶鏁?console 鏉堟挸鍤ù瀣槸缂佹挻鐏?		files: [],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'no-console': 'off',
			// obsidianmd 0.4.2 鐠?no-console 閺€鍦暠鏉╂瑦娼憴鍕灟娴狅絿顓搁敍鍫熺Х閹垰鐢?[no-console] 閸撳秶绱戦敍澶堚偓?			// 濞村鐦捄鎴濇躬 Node 闁插矉绱濋張顒佹降鐏忚精顩﹂悽?console 鏉堟挸鍤紒鎾寸亯閿涘矁绻栭柌灞肩楠炶泛鍙ч幒澶堚偓?			'obsidianmd/rule-custom-message': 'off',
			// 濞村鐦▽鈩冩箒 popout 缁愭褰涢敍瀛╫de 娑撳娈戦崗銊ョ湰鐎电钖勭亸杈ㄦЦ globalThis
			'obsidianmd/no-global-this': 'off',
			// 濞村鐦稉搴㈢€楦垮壖閺堫剚婀伴弶銉ユ皑鐠烘垵婀?Node 闁插矉绱檈sbuild 閹垫挸瀵樺ù瀣槸閵嗕浇顕伴弬鍥︽閵嗕礁鍟撴稉瀛樻閻╊喖缍嶉敍澶涚礉
			// "缁夎濮╃粩顖涚梾閺?Node API" 鏉╂瑦娼楦款唴閸︺劏绻栭柌灞肩瑝闁倻鏁?			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// 閺堫剚褰冩禒鑸垫Ц**濡楀矂娼扮粩顖欑瑩鐏?*閿涘潰anifest 闁?isDesktopOnly: true閿涘绱?		// 閸氬本顒為惄顔界垼閺勵垯绮ㄦ惔鎾茬婢舵牜娈戦弬鍥︽婢剁櫢绱漹ault API 閸戣桨绗夋禍鍡楃氨閿涘苯褰ч懗鐣屾暏 Node 閻?fs閵?		// 閹碘偓娴?缁夎濮╃粩顖涚梾閺?Node API"鏉╂瑦娼楦款唴閸︺劏绻栭柌灞炬Ц閸掔粯鍓伴惃鍕絿閼稿稄绱濇稉宥嗘Ц閻ゅ繑绱￠妴?		files: ['src/**/*.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// 閺嬪嫬缂撻悽銊ф畱闁板秶鐤嗛弬鍥︽閸氬瞼鎮婇敍姘暊娴狀剙褰ч崷?Node 娑撳绻嶇悰宀嬬礉娑撳秳绱版潻?main.js
		files: ['eslint.config.mts', 'esbuild.config.mjs', 'deploy.mjs', 'version-bump.mjs'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"deploy.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		// 瀵偓閸欐垹鏁ら惃鍕濞嗏剝鈧冧紣閸忕柉鍓奸張顒婄礄娑撳秷绻?main.js閿涘奔绡冨▽鈥茬矆娑斿牆銈界€瑰牏娈戠憴鍕叐閿?		"tools/**",
	]),
);
