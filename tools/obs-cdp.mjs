// Minimal CDP driver for the Obsidian renderer (Node 22+, native WebSocket).
// Usage:
//   node tools/obs-probe.mjs '<js expression>'            -> evaluate and print
//   node tools/obs-probe.mjs --file tools/measure.js       -> evaluate a file body
//   node tools/obs-probe.mjs --await '<js promise expr>'   -> awaitPromise
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const PORT = process.env.OBS_CDP_PORT ?? '9223';

const args = process.argv.slice(2);
let awaitPromise = false;
let bringToFront = false;
let shotPath = null;
let pull = null;
let drive = null;
let targetMatch = null;
let screencast = false;
let exprSource = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--await') awaitPromise = true;
  else if (args[i] === '--front') bringToFront = true;
  else if (args[i] === '--cast') screencast = true;
  else if (args[i] === '--target') targetMatch = args[++i];
  else if (args[i] === '--shot') shotPath = args[++i];
  else if (args[i] === '--pull') pull = [args[++i], args[++i]];
  else if (args[i] === '--drive') drive = new URL(args[++i], `file://${process.cwd()}/`).href;
  else if (args[i] === '--file') exprSource = fs.readFileSync(args[i + 1], 'utf8');
  else if (!exprSource) exprSource = args[i];
}
if (!exprSource && !shotPath && !pull && !drive) {
  console.error('no expression');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page');
let page = null;
if (targetMatch) page = pages.find((t) => t.url.includes(targetMatch) || t.title.includes(targetMatch));
if (!page) page = pages.find((t) => t.url.startsWith('app://obsidian.md/index.html'));
if (!page) page = pages.find((t) => t.url.startsWith('app://'));
if (!page) page = pages[0];
if (!page) {
  console.error('no page target');
  process.exit(2);
}
if (targetMatch) {
  if (!pages.some((t) => t.url.includes(targetMatch) || t.title.includes(targetMatch))) {
    console.error(`WARNING: no page matches --target ${targetMatch}, using ${page.url.slice(0, 60)}`);
  }
  console.error(`target: ${page.url.slice(0, 60)} | ${page.title.slice(0, 60)}`);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((res) => pending.set(n, res));
}

if (bringToFront) {
  await send('Page.enable', {});
  await send('Page.bringToFront', {});
  await new Promise((r) => setTimeout(r, 1000));
}

if (screencast) {
  await send('Page.enable', {});
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Page.screencastFrame') {
      send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
    }
  });
  const started = await send('Page.startScreencast', {
    format: 'jpeg',
    quality: 10,
    maxWidth: 320,
    maxHeight: 240,
    everyNthFrame: 3,
  });
  if (started.error) console.error(`screencast refused: ${started.error.message}`);
}

if (drive) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = async (expression, opts = {}) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180000,
      ...opts,
    });
    if (res.error) {
      throw new Error(`CDP ${res.error.code} ${res.error.message}${res.error.data ? " " + res.error.data : ""}`);
    }
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result.result.value;
  };
  const KEY = { left: 'left', right: 'right', middle: 'middle', back: 'back', forward: 'forward' };
  const BUTTON_BIT = { left: 1, right: 2, middle: 4 };
  // Chromium routes a press to the pointer position it already knows: dispatching mousePressed
  // cold lands on the previous hover target and the page never sees a pointerdown. So every
  // gesture moves to the point first, and presses carry a buttons bitmask like a real mouse.
  let heldBits = 0;
  const mouse = async (type, x, y, o = {}) => {
    const name = KEY[o.button ?? 'left'];
    const bit = BUTTON_BIT[name] ?? 0;
    const mods = o.ctrl ? 2 : o.alt ? 1 : o.shift ? 8 : 0;
    const move = (buttons) =>
      send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        clickCount: 0,
        buttons: buttons,
        modifiers: mods,
      });
    const press = (clickCount) =>
      send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: name, clickCount, buttons: bit, modifiers: mods });
    const release = () =>
      send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: name, clickCount: 1, buttons: 0, modifiers: mods });

    if (type === 'move') {
      // a drag move must report the held button, or Blink's input state goes inconsistent
      // and the matching release is never delivered to the page
      await move(o.held ? BUTTON_BIT[o.held] ?? bit : heldBits);
    } else if (type === 'down') {
      await move(0);
      await sleep(o.moveWaitMs ?? 25);
      await press(1);
      heldBits = bit;
    } else if (type === 'up') {
      await move(bit);
      await release();
      heldBits = 0;
    } else if (type === 'click') {
      await move(0);
      await sleep(o.moveWaitMs ?? 25);
      await press(1);
      heldBits = bit;
      await sleep(o.holdMs ?? 40);
      await release();
      heldBits = 0;
    } else if (type === 'double') {
      await move(0);
      await sleep(o.moveWaitMs ?? 25);
      await press(1);
      await release();
      await sleep(o.holdMs ?? 40);
      await press(2);
      await release();
      heldBits = 0;
    }
    await sleep(o.waitMs ?? 60);
  };
  // A trusted mouseWheel is the real input path, but it only resolves while the compositor
  // produces frames: with the session blanked (org.gnome.ScreenSaver GetActive = true) Chromium
  // waits for a BeginFrame that never arrives. So the trusted call races a timeout and falls
  // back to an in-page WheelEvent, which our own handler accepts untrusted.
  const wheel = async (x, y, deltaY, o = {}) => {
    try {
      await Promise.race([
        send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: o.deltaX ?? 0,
          deltaY,
          deltaMode: o.deltaMode ?? 0,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('no BeginFrame')), o.timeoutMs ?? 4000)),
      ]);
      await sleep(o.waitMs ?? 80);
      return 'trusted mouseWheel';
    } catch {
      const res = await evalJs(`(function () {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return 'no element at point';
        const evt = new WheelEvent('wheel', {
          deltaY: ${deltaY},
          deltaX: ${o.deltaX ?? 0},
          deltaMode: ${o.deltaMode ?? 0},
          clientX: ${x},
          clientY: ${y},
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(evt);
        return evt.defaultPrevented ? 'synthetic WheelEvent, consumed' : 'synthetic WheelEvent, not consumed';
      })()`);
      await sleep(o.waitMs ?? 80);
      return res;
    }
  };
  const shot = async (file) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
    return file;
  };
  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    // rawKeyDown on purpose: these are the camera zoom keys, and must not type into a field
    Equal: { key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187 },
    Minus: { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, nativeVirtualKeyCode: 189 },
  };
  const key = async (name, o = {}) => {
    const k = KEYS[name];
    if (!k) throw new Error(`unknown key ${name}`);
    const mods = o.ctrl ? 2 : o.shift ? 8 : 0;
    await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k, modifiers: mods });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, modifiers: mods });
    await sleep(o.waitMs ?? 80);
  };
  // Input.insertText lands in the focused field with real beforeinput/input events, which is
  // what Obsidian's components listen for; per-character keyDown pairs do not update a value.
  const type = async (text, o = {}) => {
    await send('Input.insertText', { text });
    await sleep(o.waitMs ?? 120);
  };
  const gdbus = (method, extra = []) =>
    new Promise((res) =>
      execFile(
        'gdbus',
        ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver', '--method', method, ...extra],
        (err, stdout) => res(err ? `ERR ${err.message}` : stdout.trim()),
      ),
    );
  // Mutter blanks the session on idle, and a blanked Wayland compositor stops producing BeginFrames:
  // rAF inside the webview freezes, trusted mouseWheel calls never resolve, and queued input events
  // get delivered one per rare frame. The idle counter cannot be reset (IdleMonitor.ResetIdletime is
  // debug-gated, Shell Eval is refused, no xdotool/wtype here), but clearing the saver state restores
  // frames within a second, so scenarios wake the display before they measure anything time-sensitive.
  const wake = async () => {
    const before = await gdbus('org.gnome.ScreenSaver.GetActive');
    if (before.startsWith('(true')) await gdbus('org.gnome.ScreenSaver.SetActive', ['false']);
    return before.startsWith('(true') ? 'blanked -> cleared' : 'already awake';
  };
  // Second cure for the same stall: an occluded window is re-raised by the compositor, which
  // makes Chromium treat it as visible again and resume the frame sink.
  let pageEnabled = false;
  const raise = async () => {
    if (!pageEnabled) {
      await send('Page.enable', {});
      pageEnabled = true;
    }
    await send('Page.bringToFront', {});
    await sleep(400);
    return 'raised';
  };
  const scenario = (await import(drive)).default;
  const report = await scenario({ send, evalJs, mouse, wheel, key, type, shot, sleep, wake, raise });
  if (report !== undefined) console.log(typeof report === 'string' ? report : JSON.stringify(report, null, 1));
  ws.close();
  process.exit(0);
}

if (pull) {
  const [key, out] = pull;
  const len = await readValue(`${key}.length`);
  let b64 = '';
  for (let off = 0; off < len; off += 40000) {
    b64 += await readValue(`${key}.substr(${off},40000)`);
  }
  const raw = b64.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(out, Buffer.from(raw, 'base64'));
  console.log(`${out}: ${fs.statSync(out).size} bytes from ${len} chars`);
  ws.close();
  process.exit(0);
}

async function readValue(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result.result.value;
}

let value;
if (exprSource) {
  const response = await send('Runtime.evaluate', {
    expression: exprSource,
    awaitPromise,
    returnByValue: true,
    timeout: 120000,
  });
  const result = response.result;
  if (result.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 1));
    process.exit(1);
  }
  value = result.result?.value;
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 1));
}

if (shotPath) {
  await send('Page.enable', {});
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log(`screenshot -> ${shotPath} (${fs.statSync(shotPath).size} bytes)`);
}
ws.close();
process.exit(0);
