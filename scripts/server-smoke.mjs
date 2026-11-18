import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const profile = process.env.DIRLUME_BUILD_PROFILE ?? "release";
const executable = resolve(`src-tauri/target/${profile}/dirlume-server${process.platform === "win32" ? ".exe" : ""}`);

export async function port() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await promisify(socket.close.bind(socket))();
  return port;
}

export async function fixture(prefix) {
  const base = resolve(".smoke");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

export async function close(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

export function post(invitation, path, payload, authorized = true) {
  const { address, certificate, token } = invitation;
  const ca = new X509Certificate(Buffer.from(certificate, "base64url")).toString();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL(path, address), {
      method: "POST", ca, timeout: 5000,
      headers: {
        authorization: `Bearer ${authorized ? token : "invalid"}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.on("timeout", () => outgoing.destroy(new Error("Server request timed out")));
    outgoing.end(body);
  });
}

export async function withServer(check) {
  const temp = await fixture("server-");
  const root = join(temp, "share");
  const state = join(temp, "state");
  const listenPort = await port();
  await mkdir(join(root, "folder"), { recursive: true });
  const bytes = Buffer.from([0, 1, 2, 100, 200, 255]);
  await writeFile(join(root, "folder", "файл.bin"), bytes);
  await writeFile(join(root, "folder", "remote.md"), "# Remote Markdown\n");
  await writeFile(join(temp, "outside.txt"), "private");
  const child = spawn(executable, ["serve", "--root", root, "--state-dir", state,
    "--host", "127.0.0.1", "--bind", `127.0.0.1:${listenPort}`], { windowsHide: true });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("error", (error) => { logs += String(error); });
  try {
    for (let attempt = 0; !logs.includes("Dirlume server listening"); attempt++) {
      if (attempt >= 100 || child.exitCode !== null || !child.pid) {
        throw new Error(`Server did not start. ${logs}`);
      }
      await setTimeout(100);
    }
    const invitation = (await execute(executable, ["invite", "--state-dir", state], { windowsHide: true })).stdout.trim();
    assert.ok(invitation.startsWith("dirlume-v1:"));
    const config = JSON.parse(Buffer.from(invitation.slice("dirlume-v1:".length), "base64url").toString());
    await check({ invitation, config, bytes });
  } finally {
    await close(child);
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await withServer(async ({ config, bytes }) => {
    const denied = await post(config, "/v1/list", { segments: [] }, false);
    assert.equal(denied.status, 401);
    const listing = await post(config, "/v1/list", { segments: [] });
    assert.equal(listing.status, 200);
    assert.equal(JSON.parse(listing.body).entries[0].name, "folder");
    const traversal = await post(config, "/v1/download", { segments: ["..", "outside.txt"] });
    assert.equal(traversal.status, 400);
    const download = await post(config, "/v1/download", { segments: ["folder", "файл.bin"] });
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
  });
  console.log("Verified authenticated TLS listing, binary download and traversal rejection.");
}
