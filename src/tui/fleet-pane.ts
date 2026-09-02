import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";
import { SubagentFleetComponent, type FleetViewOptions } from "./fleet.ts";
import { createHerdrClient, type HerdrClient } from "../inspectors/herdr/client.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface FleetPaneHandle {
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

/**
 * Herdr pane 版 Fleet Inspector 的 pi 侧宿主。
 *
 * 关键点：SubagentFleetComponent 实例活在 pi 进程里，因此它读到的是
 * 真实的 state.foregroundControls（内存活对象）—— 实时 transcript、
 * steer、stop 全部可用。pane 只是个哑终端，收帧、回传按键。
 */
export async function openFleetInHerdrPane(
	ctx: ExtensionContext,
	state: SubagentState,
	options: FleetViewOptions & { client?: HerdrClient; focus?: boolean } = {},
): Promise<{ ok: true; handle: FleetPaneHandle } | { ok: false; message: string }> {
	const client = options.client ?? createHerdrClient();

	// 1. 建通道目录 + 两条 fifo
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-pane-"));
	const framesPath = path.join(dir, "frames");
	const eventsPath = path.join(dir, "events");
	for (const p of [framesPath, eventsPath]) {
		if (!makeFifo(p)) return { ok: false, message: `Failed to create fifo at ${p}.` };
	}

	// 2. 开 pane。--current 依赖 HERDR_PANE_ID，缺失时退回显式 pane id。
	const hostPane = process.env.HERDR_PANE_ID?.trim();
	const target = hostPane ? [hostPane] : ["--current"];
	const split = await client.run<unknown>(
		["pane", "split", ...target, "--direction", "right", "--ratio", "0.4", options.focus ? "--focus" : "--no-focus"],
		{ timeoutMs: 15_000 },
	);
	if (!split.ok) return { ok: false, message: `herdr pane split failed: ${split.error.message}` };
	const paneId = extractPaneId(split.data);
	if (!paneId) return { ok: false, message: "herdr pane split returned no pane id." };

	// 3. 在 pane 里跑哑终端客户端
	const clientScript = path.join(import.meta.dirname, "..", "..", "fleet-pane-client.mjs");
	const command = `exec node ${JSON.stringify(clientScript)} ${JSON.stringify(dir)}`;
	const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000 });
	if (!started.ok) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return { ok: false, message: `herdr pane run failed: ${started.error.message}` };
	}

	// 4. 打开 fifo（写端 open 会阻塞到 client 打开读端，所以用异步 fd）
	const framesFd = await openWriteFifo(framesPath);
	if (framesFd === undefined) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return { ok: false, message: "Timed out waiting for pane client to attach." };
	}

	let cols = 80;
	let rows = 32;
	let disposed = false;
	let pendingFrame = false;

	// 5. 造假 tui —— 组件唯一需要的就是 terminal.rows 和 requestRender
	const fakeTui = {
		terminal: { get rows() { return rows; } },
		requestRender: () => scheduleDraw(),
	};

	const component = new SubagentFleetComponent(
		fakeTui,
		ctx.ui.theme as Theme,
		state,
		() => { void dispose(); },
		options,
	);

	function writeFrame(): void {
		if (disposed) return;
		let lines: string[];
		try {
			lines = component.render(cols);
		} catch (cause) {
			lines = [`Fleet render error: ${cause instanceof Error ? cause.message : String(cause)}`];
		}
		// 归位 + 清屏 + 帧内容，逐行 EL 清尾，避免残影
		const body = lines.map((line) => line + "\x1b[K").join("\r\n");
		const payload = `\x1b[H${body}\x1b[J`;
		try { fs.writeSync(framesFd!, payload); } catch { void dispose(); }
	}

	function scheduleDraw(): void {
		if (disposed || pendingFrame) return;
		pendingFrame = true;
		setTimeout(() => { pendingFrame = false; writeFrame(); }, 16).unref?.();
	}

	// 6. 读 pane 回传的按键 —— 直接喂给真组件的 handleInput
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
				cols = Math.max(36, msg.cols ?? cols);
				rows = Math.max(8, msg.rows ?? rows);
				writeFrame();
			} else if (msg.t === "key" && typeof msg.d === "string") {
				try { component.handleInput(Buffer.from(msg.d, "base64").toString("utf8")); } catch {}
				scheduleDraw();
			}
		}
	});
	events.on("error", () => { void dispose(); });
	events.on("end", () => { void dispose(); });

	async function dispose(): Promise<void> {
		if (disposed) return;
		disposed = true;
		try { component.dispose(); } catch {}
		try { events.destroy(); } catch {}
		try { if (framesFd !== undefined) fs.closeSync(framesFd); } catch {}
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		state.fleetInspectorOpen = false;
	}

	writeFrame();

	const handle: FleetPaneHandle = {
		paneId,
		close: async () => {
			await dispose();
			await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		},
	};
	return { ok: true, handle };
}

function makeFifo(p: string): boolean {
	try {
		return spawnSync("mkfifo", [p], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
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
