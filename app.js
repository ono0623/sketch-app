console.log("✅ app.js 読み込まれました！");

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const timelineCanvas = document.getElementById('timelineCanvas');
const tl = timelineCanvas.getContext('2d');

// 変数宣言
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
let altPressed = false;
let timelineLayout = [];
let timelineLassoStart = null;
let timelineLassoEnd = null;
let showInactive = false;

// DOM要素
const penBtn = document.getElementById('pen');
const colorPicker = document.getElementById('colorPicker');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');
const sizeSlider = document.getElementById('size');
const lassoBtn = document.getElementById('lasso');
const toggleStrokeListBtn = document.getElementById('toggleStrokeListBtn');
const strokeListEl = document.getElementById('strokeList');
const showInactiveBtn = document.getElementById('showInactiveBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');

// 定数
const INACTIVE_ALPHA_WHEN_ALT = 0.15;
const TIMELINE_LASSO_INCLUDES_INACTIVE = true;
const LASSO_MIN_PX = 6;
const DB_NAME = 'SketchAppDB';
const STORE_NAME = 'snapshots';
const PATHS_RECORD_ID = 'paths';
const DB_VERSION = 1;
let db;

// 操作カウント（クリック回数と実行回数の両方）
let operationCounts = {
  // クリック回数（ボタンを押した回数）
  penClick: 0,
  lassoClick: 0,
  undoClick: 0,
  redoClick: 0,
  clearClick: 0,
  saveClick: 0,
  exportClick: 0,
  importClick: 0,
  toggleSelectedClick: 0,
  toggleStrokeListClick: 0,
  showInactiveClick: 0,
  
  // 実行回数（実際に動作した回数）
  penExecuted: 0,
  lassoExecuted: 0,
  undoExecuted: 0,
  redoExecuted: 0,
  clearExecuted: 0,
  saveExecuted: 0,
  exportExecuted: 0,
  importExecuted: 0,
  toggleSelectedExecuted: 0,
  toggleStrokeListExecuted: 0,
  showInactiveExecuted: 0,
  
  // その他
  snapshotSwitch: 0,
  toggleActive: 0,
  strokeDrawn: 0
};

// IndexedDB 初期化
const openDB = () => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => {
    db = request.result;
    listSnapshots();
    loadAllPathsFromDB();
    loadLatestSnapshot();
  };
  request.onerror = e => {
    console.error('IndexedDB open error:', e.target.errorCode);
  };
};

openDB();

// ユーティリティ関数
function generateStrokeId() {
  return 'stroke-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function isSmallRect(p1, p2) {
  return !p1 || !p2 || (Math.abs(p2.x - p1.x) < LASSO_MIN_PX && Math.abs(p2.y - p1.y) < LASSO_MIN_PX);
}

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

function getMousePosOnTimeline(e) {
  const rect = timelineCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
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

// IndexedDB 操作
function saveAllPathsToDB() {
  if (!db) return;
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    id: PATHS_RECORD_ID,
    paths: paths.map(p => ({ ...p }))
  });
  tx.oncomplete = () => {
    console.log('saveAllPathsToDB: paths saved');
  };
  tx.onerror = e => {
    console.error('saveAllPathsToDB error:', e.target.error);
  };
}

function loadAllPathsFromDB() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(PATHS_RECORD_ID);
  req.onsuccess = () => {
    if (req.result) {
      paths = req.result.paths.map(p => {
        if (Array.isArray(p.points) && p.points.length >= 2 && !p.points[0].tAbs) {
          const startAbs = performance.now();
          const dur = Math.max(1, p.duration || 1);
          p.points = p.points.map((pt, idx) => ({
            x: pt.x,
            y: pt.y,
            tAbs: startAbs + (dur * idx / (p.points.length - 1))
          }));
          p.startTimeAbs = startAbs;
          p.endTimeAbs = startAbs + dur;
        }
        return { ...p };
      });
      updateStrokeList();
      redraw();
    }
  };
}

async function exportAllData() {
  operationCounts.exportClick++;
  operationCounts.exportExecuted++;
  console.log('Export - Click:', operationCounts.exportClick, 'Executed:', operationCounts.exportExecuted);
  
  const tx1 = db.transaction([STORE_NAME], 'readonly');
  const store1 = tx1.objectStore(STORE_NAME);
  const pathsRec = await new Promise(resolve => {
    const req = store1.get(PATHS_RECORD_ID);
    req.onsuccess = () => resolve(req.result || { id: PATHS_RECORD_ID, paths: [] });
  });

  const tx2 = db.transaction([STORE_NAME], 'readonly');
  const store2 = tx2.objectStore(STORE_NAME);
  const allRecs = await new Promise(resolve => {
    const req = store2.getAll();
    req.onsuccess = () => resolve(req.result);
  });

  const snaps = allRecs.filter(r => r.id.startsWith('snapshot-'));

  const exportObj = {
    paths: pathsRec.paths,
    snapshots: snaps.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      activeIndexes: r.activeIds,
      preview: r.preview
    })),
    operationCounts: operationCounts
  };

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sketch-data-${new Date().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(evt) {
  operationCounts.importClick++;
  
  const file = evt.target.files[0];
  if (!file) return;
  
  operationCounts.importExecuted++;
  console.log('Import - Click:', operationCounts.importClick, 'Executed:', operationCounts.importExecuted);
  
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      await new Promise(resolve => {
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve();
      });

      store.put({
        id: PATHS_RECORD_ID,
        paths: imported.paths || []
      });

      (imported.snapshots || []).forEach(snap => {
        const ids = Array.isArray(snap.activeIds) ? snap.activeIds : Array.isArray(snap.activeIndexes) ? snap.activeIndexes : [];
        store.put({
          id: snap.id,
          timestamp: snap.timestamp,
          activeIds: ids,
          preview: snap.preview
        });
      });

      await tx.complete;
      
      if (imported.operationCounts) {
        operationCounts = imported.operationCounts;
      }
      
      loadAllPathsFromDB();
      listSnapshots();
      loadLatestSnapshot();
      alert('インポート完了：全データをファイル内容で上書きしました。');
    } catch (e) {
      console.error(e);
      alert('インポート中にエラーが発生しました');
    }
  };
  reader.readAsText(file);
}

function saveSnapshot() {
  operationCounts.saveClick++;
  operationCounts.saveExecuted++;
  console.log('Save - Click:', operationCounts.saveClick, 'Executed:', operationCounts.saveExecuted);
  
  if (!db) return;
  const id = `snapshot-${Date.now()}`;
  const preview = canvas.toDataURL();
  const activeIds = paths.filter(p => p.active).map(p => p.id);
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    id,
    timestamp: new Date().toISOString(),
    activeIds,
    preview
  });
  tx.oncomplete = () => {
    saveAllPathsToDB();
    listSnapshots();
    alert('スナップショットが保存されました！');
  };
  tx.onerror = e => {
    console.error('saveSnapshot transaction error:', e.target.error);
    alert('スナップショットの保存に失敗しました');
  };
}

function loadSnapshotById(snapshotId) {
  operationCounts.snapshotSwitch++;
  console.log('Snapshot Switch count:', operationCounts.snapshotSwitch);
  
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(snapshotId);
  req.onsuccess = () => {
    const snap = req.result;
    if (!snap || !Array.isArray(snap.activeIds)) return;
    paths.forEach(p => p.active = false);
    snap.activeIds.forEach(id => {
      const p = paths.find(path => path.id === id);
      if (p) p.active = true;
    });
    updateStrokeList();
    redraw();
  };
}

function listSnapshots() {
  if (!db) return;
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  request.onsuccess = function () {
    const list = document.getElementById('snapshotList');
    list.innerHTML = '';
    const snaps = request.result.filter(r => r.id.startsWith('snapshot-'));
    snaps.forEach(snapshot => {
      const div = document.createElement('div');
      div.style.marginBottom = '10px';
      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.width = 213;
      img.height = 155;
      img.style.border = '1px solid #ccc';
      const ts = new Date(snapshot.timestamp).toLocaleString();
      img.title = ts;
      img.addEventListener('click', () => loadSnapshotById(snapshot.id));
      div.appendChild(img);
      list.appendChild(div);
    });
  };
}

function loadLatestSnapshot() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const getAllReq = store.getAll();
  getAllReq.onsuccess = () => {
    const snaps = getAllReq.result.filter(s => s.id.startsWith('snapshot-'));
    if (snaps.length === 0) return;
    const latest = snaps.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    loadSnapshotById(latest.id);
  };
}

// モード切り替え
function updateModeUI() {
  const penActive = !lassoMode;
  const lassoActive = lassoMode;
  penBtn.classList.toggle('is-active', penActive);
  lassoBtn.classList.toggle('is-active', lassoActive);
  penBtn.setAttribute('aria-pressed', String(penActive));
  lassoBtn.setAttribute('aria-pressed', String(lassoActive));
}

function setMode(mode) {
  lassoMode = (mode === 'lasso');
  selectedStrokes.clear();
  drawing = false;
  currentPath = [];
  lassoStart = null;
  lassoEnd = null;
  timelineLassoStart = null;
  timelineLassoEnd = null;
  updateModeUI();
  redraw();
  updateStrokeList();
}

// 描画関数
function drawTimeline() {
  if (!timelineCanvas || !tl) return;
  const dpr = window.devicePixelRatio || 1;
  let cssW = timelineCanvas.clientWidth;
  const cssH = timelineCanvas.clientHeight;
  cssW = Math.min(cssW, 200);
  
  if (timelineCanvas.width !== Math.floor(cssW * dpr) || timelineCanvas.height !== Math.floor(cssH * dpr)) {
    timelineCanvas.width = Math.floor(cssW * dpr);
    timelineCanvas.height = Math.floor(cssH * dpr);
    tl.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  tl.clearRect(0, 0, cssW, cssH);

  const visible = paths.filter(s => s.points && s.points.length >= 2);
  if (visible.length === 0 || !paths.length) return;

  const basis = [...paths].sort((a, b) => {
    const aStart = (a.startTime ?? a.startTimeAbs ?? a.points?.[0]?.tAbs ?? 0);
    const bStart = (b.startTime ?? b.startTimeAbs ?? b.points?.[0]?.tAbs ?? 0);
    return aStart - bStart;
  });

  const offsets = new Map();
  let cum = 0;
  for (const s of basis) {
    const s0 = s.startTimeAbs ?? s.points?.[0]?.tAbs ?? s.startTime ?? 0;
    const sN = s.endTimeAbs ?? s.points?.[s.points.length - 1]?.tAbs ?? s.endTime ?? s0;
    const dur = Math.max(1, sN - s0);
    offsets.set(s, cum);
    cum += dur;
  }
  const totalDrawMs = Math.max(1, cum);

  const xOf = (x) => (x / canvas.width) * cssW;
  const yOfPoint = (s, tAbs) => {
    const s0 = s.startTimeAbs ?? s.points?.[0]?.tAbs ?? s.startTime ?? 0;
    const base = offsets.get(s) || 0;
    const local = Math.max(0, (tAbs ?? s0) - s0);
    const compactT = base + local;
    return (compactT / totalDrawMs) * cssH;
  };

  tl.save();
  tl.strokeStyle = '#cfcfcf';
  tl.lineWidth = 1;
  for (let k = 0; k <= 5; k++) {
    const y = (k / 5) * cssH;
    tl.beginPath();
    tl.moveTo(0, y);
    tl.lineTo(cssW, y);
    tl.stroke();
  }
  tl.restore();

  timelineLayout = [];
  for (const s of visible) {
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    const mapped = pts.map(p => ({ x: xOf(p.x), y: yOfPoint(s, p.tAbs) }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of mapped) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    timelineLayout.push({
      index: paths.indexOf(s),
      id: s.id,
      active: !!s.active,
      points: mapped,
      bbox: { minX, minY, maxX, maxY }
    });
  }

  for (const s of visible) {
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    const isSelected = selectedStrokes.has(paths.indexOf(s));
    tl.save();
    tl.lineWidth = 2;
    tl.globalAlpha = s.active ? 1.0 : 0.10;
    tl.strokeStyle = s.color || '#111';
    tl.lineJoin = 'round';
    tl.lineCap = 'round';
    if (isSelected) {
      tl.setLineDash([6, 4]);
    } else {
      tl.setLineDash([]);
    }
    tl.beginPath();
    tl.moveTo(xOf(pts[0].x), yOfPoint(s, pts[0].tAbs));
    for (let j = 1; j < pts.length; j++) {
      tl.lineTo(xOf(pts[j].x), yOfPoint(s, pts[j].tAbs));
    }
    tl.stroke();
    tl.restore();
  }

  if (lassoMode && timelineLassoStart && timelineLassoEnd) {
    tl.save();
    tl.setLineDash([5, 3]);
    tl.strokeStyle = 'rgba(0,0,255,0.5)';
    tl.lineWidth = 1;
    tl.strokeRect(
      Math.min(timelineLassoStart.x, timelineLassoEnd.x),
      Math.min(timelineLassoStart.y, timelineLassoEnd.y),
      Math.abs(timelineLassoEnd.x - timelineLassoStart.x),
      Math.abs(timelineLassoEnd.y - timelineLassoStart.y)
    );
    tl.restore();
  }
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  paths.forEach((path, i) => {
    const isSelected = selectedStrokes.has(i);
    const isInactive = !path.active;
    const revealInactive = altPressed || showInactive;
    if (isInactive && !revealInactive && !isSelected) return;
    ctx.save();
    ctx.setLineDash(isSelected ? [6, 4] : []);
    if (isInactive) {
      ctx.globalAlpha = isSelected ? 0.15 : 0.15;
    } else {
      ctx.globalAlpha = 1.0;
    }
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pts = path.points;
    if (pts && pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    ctx.restore();
  });

  if (lassoMode && lassoStart && lassoEnd) {
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = 'rgba(0,0,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(lassoStart.x, lassoEnd.x),
      Math.min(lassoStart.y, lassoEnd.y),
      Math.abs(lassoEnd.x - lassoStart.x),
      Math.abs(lassoEnd.y - lassoStart.y)
    );
    ctx.restore();
  }
  drawTimeline();
}

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

function updateStrokeList() {
  const list = document.getElementById('strokeList');
  list.innerHTML = '';
  paths.forEach((path, i) => {
    const div = document.createElement('div');
    div.className = 'stroke-entry';
    if (selectedStrokes.has(i)) {
      div.style.backgroundColor = '#ffffcc';
    }
    const ts = new Date(path.startTime).toLocaleString();
    const info = document.createElement('div');
    info.innerHTML = `${ts} — ${path.duration}ms, ${path.length.toFixed(1)}px, ${path.speed.toFixed(2)}px/ms<br>
    <label>
      <input type="checkbox" ${path.active ? 'checked' : ''} onchange="toggleActive(${i})">
      Active
    </label>`;
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
  operationCounts.toggleActive++;
  console.log('Toggle Active count:', operationCounts.toggleActive);
  
  paths[index].active = !paths[index].active;
  updateStrokeList();
  redraw();
  saveAllPathsToDB();
}

function selectStrokesInLasso(p1, p2) {
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  selectedStrokes.clear();
  const revealInactive = altPressed || showInactive;
  paths.forEach((path, i) => {
    if (!path.active && !revealInactive) return;
    for (const pt of path.points) {
      if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
        selectedStrokes.add(i);
        break;
      }
    }
  });
}

function selectStrokesInTimelineLasso(p1, p2) {
  if (!timelineLayout || timelineLayout.length === 0) return;
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  const inRect = (pt) => (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY);
  selectedStrokes.clear();
  for (const item of timelineLayout) {
    if (!item.active && !TIMELINE_LASSO_INCLUDES_INACTIVE && !altPressed) continue;
    const b = item.bbox;
    const bboxOverlap = !(b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY);
    if (!bboxOverlap) continue;
    let hit = false;
    for (const pt of item.points) {
      if (inRect(pt)) {
        hit = true;
        break;
      }
    }
    if (hit) selectedStrokes.add(item.index);
  }
}

// イベントリスナー
sizeSlider.addEventListener('input', (e) => {
  penSize = parseInt(e.target.value);
});

colorPicker.addEventListener('input', (e) => {
  penColor = e.target.value;
});

penBtn.addEventListener('click', () => {
  operationCounts.penClick++;
  if (lassoMode) {
    operationCounts.penExecuted++;
  }
  console.log('Pen - Click:', operationCounts.penClick, 'Executed:', operationCounts.penExecuted);
  setMode('pen');
});

lassoBtn.addEventListener('click', () => {
  operationCounts.lassoClick++;
  if (!lassoMode) {
    operationCounts.lassoExecuted++;
  }
  console.log('Lasso - Click:', operationCounts.lassoClick, 'Executed:', operationCounts.lassoExecuted);
  setMode('lasso');
});

undoBtn.addEventListener('click', () => {
  operationCounts.undoClick++;
  if (paths.length > 0) {
    operationCounts.undoExecuted++;
    redoStack.push(paths.pop());
    updateStrokeList();
  }
  console.log('Undo - Click:', operationCounts.undoClick, 'Executed:', operationCounts.undoExecuted);
});

redoBtn.addEventListener('click', () => {
  operationCounts.redoClick++;
  if (redoStack.length > 0) {
    operationCounts.redoExecuted++;
    paths.push(redoStack.pop());
    updateStrokeList();
  }
  console.log('Redo - Click:', operationCounts.redoClick, 'Executed:', operationCounts.redoExecuted);
});

clearBtn.addEventListener('click', () => {
  operationCounts.clearClick++;
  operationCounts.clearExecuted++;
  console.log('Clear - Click:', operationCounts.clearClick, 'Executed:', operationCounts.clearExecuted);
  saveSnapshot();
  paths.forEach(path => path.active = false);
  redoStack = [];
  updateStrokeList();
  redraw();
});

saveBtn.addEventListener('click', () => {
  saveSnapshot();
});

showInactiveBtn.addEventListener('click', () => {
  operationCounts.showInactiveClick++;
  operationCounts.showInactiveExecuted++;
  console.log('Show Inactive - Click:', operationCounts.showInactiveClick, 'Executed:', operationCounts.showInactiveExecuted);
  showInactive = !showInactive;
  showInactiveBtn.classList.toggle('active', showInactive);
  showInactiveBtn.setAttribute('aria-pressed', String(showInactive));
  redraw();
  updateStrokeList();
});

toggleStrokeListBtn.addEventListener('click', () => {
  operationCounts.toggleStrokeListClick++;
  operationCounts.toggleStrokeListExecuted++;
  console.log('Toggle Stroke List - Click:', operationCounts.toggleStrokeListClick, 'Executed:', operationCounts.toggleStrokeListExecuted);
  if (strokeListEl.style.display === 'none' || strokeListEl.style.display === '') {
    strokeListEl.style.display = 'block';
  } else {
    strokeListEl.style.display = 'none';
  }
});

document.getElementById('toggleSelectedBtn').addEventListener('click', () => {
  operationCounts.toggleSelectedClick++;
  if (selectedStrokes.size > 0) {
    operationCounts.toggleSelectedExecuted++;
    selectedStrokes.forEach(index => {
      paths[index].active = !paths[index].active;
    });
    updateStrokeList();
  }
  console.log('Toggle Selected - Click:', operationCounts.toggleSelectedClick, 'Executed:', operationCounts.toggleSelectedExecuted);
});

exportBtn.addEventListener('click', exportAllData);
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', handleImportFile);

window.addEventListener('keydown', e => {
  if (e.key === 'Alt') {
    altPressed = true;
    redraw();
    updateStrokeList();
  }
  if (e.target && !/input|textarea|select/i.test(e.target.tagName)) {
    if (e.key === 'v' || e.key === 'V') {
      operationCounts.penClick++;
      if (lassoMode) {
        operationCounts.penExecuted++;
      }
      setMode('pen');
    }
    if (e.key === 'l' || e.key === 'L') {
      operationCounts.lassoClick++;
      if (!lassoMode) {
        operationCounts.lassoExecuted++;
      }
      setMode('lasso');
    }
  }
});

window.addEventListener('keyup', e => {
  if (e.key === 'Alt') {
    altPressed = false;
    redraw();
    updateStrokeList();
  }
});

// キャンバスイベント
canvas.addEventListener('mousedown', (e) => {
  if (lassoMode) {
    lassoStart = getMousePos(e);
    lassoEnd = null;
  } else {
    drawing = true;
    startTime = Date.now();
    const pos = getMousePos(e);
    currentPath = [{ x: pos.x, y: pos.y, tAbs: performance.now() }];
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
  currentPath.push({ x: pos.x, y: pos.y, tAbs: performance.now() });
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

canvas.addEventListener('mouseup', (e) => {
  if (lassoMode) {
    if (lassoStart && lassoEnd && !isSmallRect(lassoStart, lassoEnd)) {
      selectStrokesInLasso(lassoStart, lassoEnd);
    }
    lassoStart = null;
    lassoEnd = null;
    drawing = false;
    currentPath = [];
    updateStrokeList();
    redraw();
    return;
  }

  const endTime = Date.now();
  if (drawing && currentPath.length > 1) {
    operationCounts.strokeDrawn++;
    console.log('Stroke Drawn count:', operationCounts.strokeDrawn);
    
    const duration = endTime - startTime;
    const startAbs = currentPath[0].tAbs ?? performance.now();
    const endAbs = currentPath.at(-1).tAbs ?? (startAbs + duration);
    const length = calcLength(currentPath);
    const speed = length / Math.max(1, duration);
    const stroke = {
      id: generateStrokeId(),
      points: currentPath,
      size: penSize,
      color: penColor,
      startTime,
      endTime,
      duration,
      length,
      speed,
      active: true,
      startTimeAbs: startAbs,
      endTimeAbs: endAbs
    };
    paths.push(stroke);
    redoStack = [];
    updateStrokeList();
    saveAllPathsToDB();
  }
  drawing = false;
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

// タイムラインイベント
timelineCanvas.addEventListener('mousedown', (e) => {
  if (!lassoMode) return;
  timelineLassoStart = getMousePosOnTimeline(e);
  timelineLassoEnd = null;
  drawTimeline();
});

timelineCanvas.addEventListener('mousemove', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);
  drawTimeline();
});

timelineCanvas.addEventListener('mouseup', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);
  if (isSmallRect(timelineLassoStart, timelineLassoEnd)) {
    timelineLassoStart = null;
    timelineLassoEnd = null;
    drawTimeline();
    return;
  }
  selectStrokesInTimelineLasso(timelineLassoStart, timelineLassoEnd);
  timelineLassoStart = null;
  timelineLassoEnd = null;
  updateStrokeList();
  redraw();
});


async function exportOperationCountsAsCSV() {
  // CSVのヘッダー行
  let csv = 'Operation,Click Count,Executed Count\n';
  
  // 各操作のデータ行
  csv += `Pen,${operationCounts.penClick},${operationCounts.penExecuted}\n`;
  csv += `Lasso,${operationCounts.lassoClick},${operationCounts.lassoExecuted}\n`;
  csv += `Undo,${operationCounts.undoClick},${operationCounts.undoExecuted}\n`;
  csv += `Redo,${operationCounts.redoClick},${operationCounts.redoExecuted}\n`;
  csv += `Clear,${operationCounts.clearClick},${operationCounts.clearExecuted}\n`;
  csv += `Save,${operationCounts.saveClick},${operationCounts.saveExecuted}\n`;
  csv += `Export,${operationCounts.exportClick},${operationCounts.exportExecuted}\n`;
  csv += `Import,${operationCounts.importClick},${operationCounts.importExecuted}\n`;
  csv += `Toggle Selected,${operationCounts.toggleSelectedClick},${operationCounts.toggleSelectedExecuted}\n`;
  csv += `Toggle Stroke List,${operationCounts.toggleStrokeListClick},${operationCounts.toggleStrokeListExecuted}\n`;
  csv += `Show Inactive,${operationCounts.showInactiveClick},${operationCounts.showInactiveExecuted}\n`;
  csv += `Snapshot Switch,${operationCounts.snapshotSwitch},-\n`;
  csv += `Toggle Active,${operationCounts.toggleActive},-\n`;
  csv += `Stroke Drawn,${operationCounts.strokeDrawn},-\n`;
  
  // BOMを付けてUTF-8で保存（Excelで文字化け防止）
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `operation-counts-${new Date().toISOString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const exportCsvBtn = document.getElementById('exportCsvBtn');
exportCsvBtn.addEventListener('click', exportOperationCountsAsCSV);

timelineCanvas.addEventListener('touchstart', (e) => {
  if (!lassoMode) return;
  e.preventDefault();
  const t = e.touches[0];
  timelineLassoStart = getMousePosOnTimeline(t);
  timelineLassoEnd = null;
  drawTimeline();
}, { passive: false });

timelineCanvas.addEventListener('touchmove', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  e.preventDefault();
  const t = e.touches[0];
  timelineLassoEnd = getMousePosOnTimeline(t);
  drawTimeline();
}, { passive: false });

timelineCanvas.addEventListener('touchend', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  e.preventDefault();
  if (isSmallRect(timelineLassoStart, timelineLassoEnd)) {
    timelineLassoStart = null;
    timelineLassoEnd = null;
    drawTimeline();
    return;
  }
  if (timelineLassoEnd) {
    selectStrokesInTimelineLasso(timelineLassoStart, timelineLassoEnd);
  }
  timelineLassoStart = null;
  timelineLassoEnd = null;
  drawing = false;
  currentPath = [];
  updateStrokeList();
  redraw();
}, { passive: false });

timelineCanvas.addEventListener('touchcancel', () => {
  timelineLassoStart = null;
  timelineLassoEnd = null;
  drawTimeline();
}, { passive: false });

// 初期化
updateModeUI();

function syncTimelineSize() {
  timelineCanvas.style.height = canvas.clientHeight + 'px';
  drawTimeline();
}

window.addEventListener('resize', syncTimelineSize);
setTimeout(syncTimelineSize, 0);

window.toggleActive = toggleActive;