// Move/resize the Obsidian window over CDP so the stress canvas has a real size.
// Usage: node tools/obs-window.mjs [x y width height]
const PORT = process.env.OBS_CDP_PORT ?? '9223';
const [x, y, w, h] = process.argv.slice(2).map(Number);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://obsidian.md/index.html'));
if (!page) throw new Error('no obsidian page target');

const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
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
const browserSend = (method, params) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((res) => pending.set(n, res));
};

const win = await browserSend('Browser.getWindowForTarget', { targetId: page.id });
console.log('before', JSON.stringify(win.result));
if (w) {
  const res = await browserSend('Browser.setWindowBounds', {
    windowId: win.result.windowId,
    bounds: { left: x, top: y, width: w, height: h, windowState: 'normal' },
  });
  console.log('after', JSON.stringify(res.result ?? res.error));
}
ws.close();
