'use strict';
self.onmessage = (e) => {
  const { data, W, H, x, y, fill, tol } = e.data;
  const u8 = new Uint8ClampedArray(data);

  if (x < 0 || y < 0 || x >= W || y >= H) {
    self.postMessage({ done: true, bbox: null });
    return;
  }

  const idx = (px, py) => (py * W + px) * 4;
  const si = idx(x, y);
  const sr = u8[si], sg = u8[si + 1], sb = u8[si + 2], sa = u8[si + 3];
  const [fr, fg, fb, fa] = fill;

  if (Math.abs(sr - fr) < 2 && Math.abs(sg - fg) < 2 && Math.abs(sb - fb) < 2 && Math.abs(sa - fa) < 2) {
    self.postMessage({ done: true, bbox: null });
    return;
  }

  const match = (i) =>
    Math.abs(u8[i] - sr) <= tol &&
    Math.abs(u8[i + 1] - sg) <= tol &&
    Math.abs(u8[i + 2] - sb) <= tol &&
    Math.abs(u8[i + 3] - sa) <= tol;

  let minX = x, maxX = x, minY = y, maxY = y;
  const stack = [x, y];
  while (stack.length) {
    const py = stack.pop();
    const px = stack.pop();
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const i = idx(px, py);
    if (!match(i)) continue;
    u8[i] = fr; u8[i + 1] = fg; u8[i + 2] = fb; u8[i + 3] = fa;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }

  self.postMessage({
    done: true,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    buffer: u8.buffer,
    W, H
  }, [u8.buffer]);
};