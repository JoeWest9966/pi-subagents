#!/usr/bin/env node
// Herdr pane 侧的哑终端客户端。
//
// 它不包含任何 Fleet Inspector 逻辑：渲染和状态全部在 pi 进程里的
// SubagentFleetComponent 实例中。这个进程只做两件事：
//   1. frames fifo -> stdout（pi 渲染好的帧原样打印）
//   2. stdin -> events fifo（按键 / 尺寸变化回传给 pi）
//
// 用法: node fleet-pane-client.mjs <channelDir>

import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2];
if (!dir) {
	process.stderr.write("fleet-pane-client: missing channel dir\n");
	process.exit(2);
}

const framesPath = path.join(dir, "frames");
const eventsPath = path.join(dir, "events");

const out = process.stdout;
let events;
let closed = false;

function cleanup(code = 0) {
	if (closed) return;
	closed = true;
	try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
	// 退出备用屏、显示光标
	try { out.write("\x1b[?25h\x1b[?1049l"); } catch {}
	try { events?.end(); } catch {}
	process.exit(code);
}

// 进备用屏幕，隐藏光标 —— 和 pi 弹窗一样的画布语义
out.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");

// --- 事件上行通道 ---
events = fs.createWriteStream(eventsPath, { flags: "a" });
events.on("error", () => cleanup(0));

function send(payload) {
	if (closed) return;
	try { events.write(JSON.stringify(payload) + "\n"); } catch {}
}

function sendResize() {
	send({ t: "resize", cols: out.columns || 80, rows: out.rows || 24 });
}

// --- 帧下行通道 ---
const frames = fs.createReadStream(framesPath);
frames.on("data", (chunk) => { if (!closed) out.write(chunk); });
frames.on("error", () => cleanup(0));
frames.on("end", () => cleanup(0));

// --- 键盘 ---
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
	// Ctrl+C 本地兜底退出，避免 pane 卡死
	if (chunk.length === 1 && chunk[0] === 0x03) {
		send({ t: "key", d: chunk.toString("base64") });
		cleanup(0);
		return;
	}
	send({ t: "key", d: chunk.toString("base64") });
});

out.on("resize", sendResize);
sendResize();

process.on("SIGTERM", () => cleanup(0));
process.on("SIGINT", () => cleanup(0));
process.on("SIGHUP", () => cleanup(0));
