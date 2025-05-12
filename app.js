console.log("✅ script.js 読み込まれました！");

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let drawing = false;
let lassoMode = false;
let lassoStart = null;
let lassoEnd = null;
let penSize = 2;
let penColor = '#000000';
let paths = [];
let undoStack = [];
let redoStack = [];
let currentPath = [];
let startTime = 0;
let selectedStrokes = new Set();

const penBtn = document.getElementById('pen');
const colorPicker = document.getElementById('colorPicker');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');
const sizeSlider = document.getElementById('size');
const lassoBtn = document.getElementById('lasso');
const DB_NAME = 'SketchAppDB';
const STORE_NAME = 'snapshots';
const DB_VERSION = 1;
let db;

const openDB = () => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = function (e) {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = function (e) {
    db = e.target.result;
    loadSnapshot();
    listSnapshots();
  };
  request.onerror = function (e) {
    console.error("IndexedDB error:", e.target.errorCode);
  };
};

openDB();

sizeSlider.addEventListener('input', (e) => {
  penSize = parseInt(e.target.value);
});
colorPicker.addEventListener('input', (e) => {
  penColor = e.target.value;
});
lassoBtn.addEventListener('click', () => {
  lassoMode = !lassoMode;
  selectedStrokes.clear();
  redraw();
  updateStrokeList();
});

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

canvas.addEventListener('mousedown', (e) => {
  if (lassoMode) {
    lassoStart = getMousePos(e);
    lassoEnd = null;
  } else {
    drawing = true;
    startTime = Date.now();
    currentPath = [getMousePos(e)];
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (lassoMode && lassoStart) {
    lassoEnd = getMousePos(e);
    redraw();
    return;
  }
  if (!drawing) return;
  const pos = getMousePos(e);
  currentPath.push(pos);
  ctx.lineWidth = penSize;
  ctx.lineCap = 'round';
  ctx.strokeStyle = penColor;
  const len = currentPath.length;
  if (len >= 2) {
    const p1 = currentPath[len - 2];
    const p2 = currentPath[len - 1];
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
});

canvas.addEventListener('mouseup', () => {
  if (lassoMode && lassoStart && lassoEnd) {
    selectStrokesInLasso(lassoStart, lassoEnd);
    lassoStart = null;
    lassoEnd = null;
    updateStrokeList();
    redraw();
    return;
  }
  drawing = false;
  const endTime = Date.now();
  if (currentPath.length > 1) {
    const length = calcLength(currentPath);
    const duration = endTime - startTime;
    const speed = length / duration;
    paths.push({
      points: currentPath,
      size: penSize,
      color: penColor,
      startTime,
      endTime,
      duration,
      length,
      speed,
      active: true
    });
    redoStack = [];
    updateStrokeList();
  }
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
  canvas.dispatchEvent(new MouseEvent('mousedown', fakeEvent));
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
  canvas.dispatchEvent(new MouseEvent('mousemove', fakeEvent));
});

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  canvas.dispatchEvent(new MouseEvent('mouseup', {}));
});


function selectStrokesInLasso(p1, p2) {
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  selectedStrokes.clear();
  paths.forEach((path, i) => {
    for (let pt of path.points) {
      if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
        selectedStrokes.add(i);
        break;
      }
    }
  });
}

function calcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  paths.forEach(path => {
    if (!path.active) return;
    const points = path.points;
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.size;
    ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i++) {
      ctx.beginPath();
      ctx.moveTo(points[i - 1].x, points[i - 1].y);
      ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
  });
  if (lassoMode && lassoStart && lassoEnd) {
    ctx.strokeStyle = 'rgba(0,0,255,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(
      Math.min(lassoStart.x, lassoEnd.x),
      Math.min(lassoStart.y, lassoEnd.y),
      Math.abs(lassoEnd.x - lassoStart.x),
      Math.abs(lassoEnd.y - lassoStart.y)
    );
    ctx.setLineDash([]);
  }
}

function updateStrokeList() {
  const list = document.getElementById('strokeList');
  list.innerHTML = '';
  paths.forEach((path, i) => {
    const div = document.createElement('div');
    div.className = 'stroke-entry';
    if (selectedStrokes.has(i)) {
      div.style.backgroundColor = '#ffffcc';
    }
    const info = document.createElement('div');
    info.innerHTML = `Stroke ${i + 1} - ${path.duration}ms, ${path.length.toFixed(1)}px, ${path.speed.toFixed(2)}px/ms
      <label><input type="checkbox" ${path.active ? 'checked' : ''} onchange="toggleActive(${i})"> Active</label>`;
    const preview = document.createElement('canvas');
    preview.width = 100;
    preview.height = 50;
    preview.style.border = '1px solid #ccc';
    drawPreview(preview, path);
    div.appendChild(info);
    div.appendChild(preview);
    list.appendChild(div);
  });
  redraw();
}

function toggleActive(index) {
  paths[index].active = !paths[index].active;
  updateStrokeList();
}

undoBtn.addEventListener('click', () => {
  if (paths.length > 0) {
    redoStack.push(paths.pop());
    updateStrokeList();
  }
});
redoBtn.addEventListener('click', () => {
  if (redoStack.length > 0) {
    paths.push(redoStack.pop());
    updateStrokeList();
  }
});

function saveSnapshot() {
  if (!db) return;
  const id = `snapshot-${Date.now()}`;
  const preview = canvas.toDataURL(); 
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const snapshot = {
    id,
    timestamp: new Date(),
    paths: paths,
    preview: preview
  };
  store.put(snapshot);
  alert('スナップショットが保存されました！');
  listSnapshots();
}

clearBtn.addEventListener('click', () => {
  saveSnapshot();
  paths.forEach(path => path.active = false);
  redoStack = [];
  updateStrokeList();
  redraw();
});

function drawPreview(canvas, path) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const points = path.points;
  if (points.length < 2) return;
  const bounds = getBounds(points);
  const scaleX = canvas.width / (bounds.maxX - bounds.minX + 1);
  const scaleY = canvas.height / (bounds.maxY - bounds.minY + 1);
  const scale = Math.min(scaleX, scaleY);
  ctx.lineWidth = path.size * scale;
  ctx.lineCap = 'round';
  ctx.strokeStyle = path.color;
  ctx.beginPath();
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1];
    const p2 = points[i];
    ctx.moveTo((p1.x - bounds.minX) * scale, (p1.y - bounds.minY) * scale);
    ctx.lineTo((p2.x - bounds.minX) * scale, (p2.y - bounds.minY) * scale);
  }
  ctx.stroke();
}

function getBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  });
  return { minX, minY, maxX, maxY };
}



function loadSnapshot() {
  if (!db) return;
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.get('latest');
  request.onsuccess = function () {
    if (request.result) {
      paths = request.result.paths;
      redoStack = [];
      updateStrokeList();
      redraw();
      console.log("スナップショットを読み込みました");
    }
  };
  request.onerror = function (e) {
    console.error("読み込み失敗:", e.target.errorCode);
  };
}

function listSnapshots() {
  if (!db) return;

  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();

  request.onsuccess = function () {
    const list = document.getElementById('snapshotList');
    list.innerHTML = ''; // 前回の一覧をクリア（← これが多重表示防止に重要）

    request.result.forEach(snapshot => {
      const div = document.createElement('div');
      div.style.marginBottom = '10px';

      const label = document.createElement('div');
      label.textContent = `${snapshot.id} - ${new Date(snapshot.timestamp).toLocaleString()}`;

      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.width = 160;
      img.height = 120;
      img.style.border = '1px solid #ccc';

      const loadBtn = document.createElement('button');
      loadBtn.textContent = '読み込む';
      loadBtn.onclick = () => loadSnapshotById(snapshot.id);

      div.appendChild(label);
      div.appendChild(img);
      div.appendChild(loadBtn);
      list.appendChild(div);
    });
  };
}

function loadSnapshotById(id) {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.get(id);
  request.onsuccess = function () {
    if (request.result) {
      paths = request.result.paths;
      redoStack = [];
      updateStrokeList();
      redraw();
      alert(`「${id}」を読み込みました！`);
    }
  };
}

saveBtn.addEventListener('click', () => {
  saveSnapshot();
});

window.toggleActive = toggleActive;

