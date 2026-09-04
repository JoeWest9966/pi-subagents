#!/usr/bin/env node

/**
 * ensure-config.mjs — postinstall 配置自举（v1.14.10 跨机器克隆闭环）。
 *
 * pi install git:<本仓库> 会把仓库 clone 到 ~/.pi/agent/git/<host>/<path>
 * 并跑 npm install；本脚本作为 package.json 的 postinstall 在那一刻执行，
 * 把仓库内的 config.example.json 写到运行时配置路径：
 *
 *   <agentDir>/extensions/subagent/config.json
 *
 * 该路径与 src/extension/config.ts 的 getConfigPath() 一致 —— pi-subagents
 * 运行时只认这个固定路径，仓库里的任何文件都不会被自动拷过去，所以
 * 必须由安装钩子补上，否则克隆/新装的实例缺配置（fleetView 等开关落空）。
 *
 * 硬约束：目标文件已存在时绝不覆盖 —— 那是用户/实例的现行配置，
 * 自举只负责「缺失时补默认值」。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 定位仓库根：本脚本在 <root>/scripts/ 下，config.example.json 在根目录。
// 用 import.meta.url 而不是 process.cwd() —— npm 的生命周期脚本 cwd 是
// 包根，但手动执行时 cwd 不可控，按脚本自身位置推最稳。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const examplePath = path.join(repoRoot, "config.example.json");

// 与 src/extension/config.ts 的 getAgentDir() 对齐：PI_CODING_AGENT_DIR
// 优先（Nous 的 piRun 安装时会显式设置，指向目标实例 agent 目录），
// 支持 "~" 与 "~/" 前缀；都没设则回退默认 ~/.pi/agent。
function agentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) {
		return path.join(home, configured.slice(2));
	}
	return configured || path.join(home, ".pi", "agent");
}

const targetDir = path.join(agentDir(), "extensions", "subagent");
const targetPath = path.join(targetDir, "config.json");

if (existsSync(targetPath)) {
	console.log(`[pi-subagents] config.json already exists, keeping current config: ${targetPath}`);
	process.exit(0);
}

try {
	const defaults = JSON.parse(readFileSync(examplePath, "utf-8"));
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(defaults, null, 2)}\n`);
	console.log(`[pi-subagents] generated default config: ${targetPath}`);
} catch (err) {
	// 显式失败，不静默吞掉 —— 安装方（pi install / Nous）会把输出亮出来。
	console.error(`[pi-subagents] failed to write config at ${targetPath}:`, err?.message || err);
	process.exit(1);
}
