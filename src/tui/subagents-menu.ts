/**
 * subagents-menu —— 指挥官模式开关面板。
 *
 * 复用 fleet-pane 的 fifo 传输和 fleet-pane-client.mjs（哑终端），
 * 只是渲染的不是 Fleet Inspector 而是一张配置开关表。
 *
 * 定位：默认劈在 fleet pane 下方（--direction down）。给了 anchorPaneId
 * 就劈那个 pane，否则劈当前 pane。
 *
 * 重要约束：pi-subagents 在 src/extension/index.ts:422 是
 * `const config = loadConfig()` —— 启动时一次性快照进闭包。
 * 所以这里写盘之后**当前会话不生效**，必须重启 pi。
 * 菜单会明确显示这一点，不假装是实时开关。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getConfigPath, updateConfig } from "../extension/config.ts";
import type { ExtensionConfig } from "../shared/types.ts";
import { resolveWaitToolConfig } from "../runs/background/wait-config.ts";
import { createHerdrClient, type HerdrClient } from "../inspectors/herdr/client.ts";

export interface MenuPaneHandle {
	paneId: string;
	close(): Promise<void>;
}

interface PaneRecord { [key: string]: unknown }

function extractPaneId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as PaneRecord;
	const direct = record.pane_id ?? record.paneId ?? record.id;
	if (typeof direct === "string" && direct) return direct;
	for (const key of ["result", "pane", "new_pane", "newPane", "created"]) {
		const nested = extractPaneId(record[key]);
		if (nested) return nested;
	}
	return undefined;
}

// ---------- 开关定义 ----------
// 每个开关知道怎么读自己的当前值、怎么写回配置。
// 加新开关只需要往这个数组里加一项。

interface Toggle {
	key: string;
	label: string;
	/** 为什么要这个开关 —— 直接显示给用户，不用去翻文档 */
	why: string;
	read: (config: ExtensionConfig) => boolean;
	write: (config: ExtensionConfig, next: boolean) => ExtensionConfig;
	/** 改完需要重启才生效 */
	needsRestart: boolean;
}

const TOGGLES: Toggle[] = [
	{
		key: "commander",
		label: "指挥官模式",
		why: "任务一律派给子 agent 后台跑，且主 agent 不阻塞等结果 → 你能连续发消息不排队",
		read: (c) => c.forceTopLevelAsync === true && resolveWaitToolConfig(c.waitTool).enabled === false,
		write: (c, next) => next
			? { ...c, forceTopLevelAsync: true, waitTool: { ...(typeof c.waitTool === "object" && c.waitTool ? c.waitTool : {}), enabled: false } }
			: { ...c, forceTopLevelAsync: false, waitTool: { ...(typeof c.waitTool === "object" && c.waitTool ? c.waitTool : {}), enabled: true } },
		needsRestart: true,
	},
	{
		key: "forceAsync",
		label: "\u2514 强制后台派发",
		why: "顶层任务一律 async:true（forceTopLevelAsync）",
		read: (c) => c.forceTopLevelAsync === true,
		write: (c, next) => ({ ...c, forceTopLevelAsync: next }),
		needsRestart: true,
	},
	{
		key: "noWait",
		label: "\u2514 禁止阻塞等待",
		why: "subagent_wait 立即返回，主 agent 不站在门口等（waitTool.enabled=false）",
		read: (c) => resolveWaitToolConfig(c.waitTool).enabled === false,
		write: (c, next) => ({ ...c, waitTool: { ...(typeof c.waitTool === "object" && c.waitTool ? c.waitTool : {}), enabled: !next } }),
		needsRestart: true,
	},
	{
		key: "fleetView",
		label: "Fleet 活动条",
		why: "编辑器下方显示子 agent 实时活动",
		read: (c) => c.fleetView !== false,
		write: (c, next) => ({ ...c, fleetView: next }),
		needsRestart: true,
	},
];

function makeFifo(p: string): boolean {
	try { return spawnSync("mkfifo", [p], { stdio: "ignore" }).status === 0; } catch { return false; }
}

function openWriteFifo(p: string, timeoutMs = 15_000): Promise<number | undefined> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = () => {
			fs.open(p, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, (err, fd) => {
				if (!err) { resolve(fd); return; }
				if (Date.now() > deadline) { resolve(undefined); return; }
				setTimeout(attempt, 120).unref?.();
			});
		};
		attempt();
	});
}

export async function openSubagentsMenuPane(
	options: {
		client?: HerdrClient;
		/** 劈这个 pane（通常是 fleet pane），缺省劈当前 pane */
		anchorPaneId?: string;
		focus?: boolean;
		/** 载入配置的函数，便于测试注入 */
		loadConfig: () => ExtensionConfig;
	},
): Promise<{ ok: true; handle: MenuPaneHandle } | { ok: false; message: string }> {
	const client = options.client ?? createHerdrClient();

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-menu-"));
	const framesPath = path.join(dir, "frames");
	const eventsPath = path.join(dir, "events");
	for (const p of [framesPath, eventsPath]) {
		if (!makeFifo(p)) return { ok: false, message: `Failed to create fifo at ${p}.` };
	}

	// 优先劈 fleet pane（形成右侧上下两格），否则劈当前 pane
	const anchor = options.anchorPaneId ?? process.env.HERDR_PANE_ID?.trim();
	const target = anchor ? [anchor] : ["--current"];
	const split = await client.run<unknown>(
		["pane", "split", ...target, "--direction", "down", "--ratio", "0.45", options.focus ? "--focus" : "--no-focus"],
		{ timeoutMs: 15_000 },
	);
	if (!split.ok) return { ok: false, message: `herdr pane split failed: ${split.error.message}` };
	const paneId = extractPaneId(split.data);
	if (!paneId) return { ok: false, message: "herdr pane split returned no pane id." };

	const clientScript = path.join(import.meta.dirname, "..", "..", "fleet-pane-client.mjs");
	const command = `exec node ${JSON.stringify(clientScript)} ${JSON.stringify(dir)}`;
	const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000 });
	if (!started.ok) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return { ok: false, message: `herdr pane run failed: ${started.error.message}` };
	}

	const framesFd = await openWriteFifo(framesPath);
	if (framesFd === undefined) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return { ok: false, message: "Timed out waiting for menu pane client to attach." };
	}

	let cols = 80;
	let rows = 24;
	let selected = 0;
	let disposed = false;
	let notice: { text: string; kind: "ok" | "err" } | undefined;
	let restartPending = false;
	let config = options.loadConfig();

	const C = {
		r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m",
		g: "\x1b[32m", y: "\x1b[33m", e: "\x1b[31m", c: "\x1b[36m", m: "\x1b[35m", gray: "\x1b[90m",
	};

	function wrap(text: string, width: number, indent: string): string[] {
		const out: string[] = [];
		let line = "";
		for (const word of text.split(/\s+/)) {
			if (line && (line + " " + word).length > width) { out.push(line); line = word; }
			else line = line ? line + " " + word : word;
		}
		if (line) out.push(line);
		return out.map((l, i) => (i === 0 ? l : indent + l));
	}

	function render(): string[] {
		const inner = Math.max(20, cols - 2);
		const lines: string[] = [];
		const bar = (l: string, r: string) => C.gray + l + "\u2500".repeat(Math.max(0, inner)) + r + C.r;

		lines.push(bar("\u256d", "\u256e"));
		const title = ` ${C.b}Subagents 菜单${C.r}`;
		const hint = restartPending ? `${C.y}需重启 pi 生效${C.r} ` : `${C.dim}配置开关${C.r} `;
		const pad = Math.max(1, inner - 14 - (restartPending ? 14 : 8));
		lines.push(C.gray + "\u2502" + C.r + title + " ".repeat(pad) + hint + C.gray + "\u2502" + C.r);
		lines.push(bar("\u251c", "\u2524"));

		TOGGLES.forEach((t, i) => {
			const on = t.read(config);
			const sel = i === selected;
			const marker = sel ? C.c + "\u276f" + C.r : " ";
			const box = on ? C.g + "[\u2713]" + C.r : C.gray + "[ ]" + C.r;
			const label = sel ? C.b + t.label + C.r : t.label;
			lines.push(`${C.gray}\u2502${C.r} ${marker} ${box} ${label}`);
			if (sel) {
				for (const w of wrap(t.why, inner - 8, "       ")) {
					lines.push(`${C.gray}\u2502${C.r}     ${C.dim}${w}${C.r}`);
				}
			}
		});

		lines.push(bar("\u251c", "\u2524"));
		if (notice) {
			const color = notice.kind === "ok" ? C.g : C.e;
			for (const w of wrap(notice.text, inner - 4, "   ")) {
				lines.push(`${C.gray}\u2502${C.r} ${color}${w}${C.r}`);
			}
		} else {
			lines.push(`${C.gray}\u2502${C.r} ${C.dim}${path.basename(path.dirname(getConfigPath()))}/config.json${C.r}`);
		}
		lines.push(bar("\u251c", "\u2524"));
		lines.push(`${C.gray}\u2502${C.r} ${C.dim}j/k 移动 \u00b7 空格/回车 切换 \u00b7 r 重载 \u00b7 q 关闭${C.r}`);
		lines.push(bar("\u2570", "\u256f"));
		return lines;
	}

	function draw(): void {
		if (disposed) return;
		const body = render().map((l) => l + "\x1b[K").join("\r\n");
		try { fs.writeSync(framesFd!, `\x1b[H${body}\x1b[J`); } catch { void dispose(); }
	}

	function toggle(): void {
		const t = TOGGLES[selected];
		if (!t) return;
		const current = t.read(config);
		try {
			config = updateConfig((c) => t.write(c, !current));
			notice = { text: `${t.label} \u2192 ${!current ? "开" : "关"}${t.needsRestart ? "（重启 pi 生效）" : ""}`, kind: "ok" };
			if (t.needsRestart) restartPending = true;
		} catch (cause) {
			notice = { text: `写入失败: ${cause instanceof Error ? cause.message : String(cause)}`, kind: "err" };
		}
		draw();
	}

	const events = fs.createReadStream(eventsPath, { encoding: "utf8" });
	let buffer = "";
	events.on("data", (chunk) => {
		buffer += chunk;
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			let msg: { t?: string; d?: string; cols?: number; rows?: number };
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg.t === "resize") {
				cols = Math.max(30, msg.cols ?? cols);
				rows = Math.max(6, msg.rows ?? rows);
				draw();
			} else if (msg.t === "key" && typeof msg.d === "string") {
				const k = Buffer.from(msg.d, "base64").toString("utf8");
				if (k === "j" || k === "\x1b[B") { selected = Math.min(TOGGLES.length - 1, selected + 1); notice = undefined; draw(); }
				else if (k === "k" || k === "\x1b[A") { selected = Math.max(0, selected - 1); notice = undefined; draw(); }
				else if (k === " " || k === "\r" || k === "\n") toggle();
				else if (k === "r") { try { config = options.loadConfig(); notice = { text: "已重载配置", kind: "ok" }; } catch (e) { notice = { text: String(e), kind: "err" }; } draw(); }
				else if (k === "q" || k === "\x03" || k === "\x1b") void dispose();
			}
		}
	});
	events.on("error", () => { void dispose(); });
	events.on("end", () => { void dispose(); });

	async function dispose(): Promise<void> {
		if (disposed) return;
		disposed = true;
		try { events.destroy(); } catch {}
		try { if (framesFd !== undefined) fs.closeSync(framesFd); } catch {}
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}

	draw();

	return {
		ok: true,
		handle: {
			paneId,
			close: async () => {
				await dispose();
				await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
			},
		},
	};
}
