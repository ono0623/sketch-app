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
let altPressed = false;

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
const PATHS_RECORD_ID = 'paths';
const DB_VERSION = 1;
let db;

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
    loadAllPathsFromDB();    // ← ① まずストロークデータを復元
    loadLatestSnapshot();    // ← ② 次に最新スナップショットの active 状態だけ適用
  };

  request.onerror = e => {
    console.error('IndexedDB open error:', e.target.errorCode);
  };
};

openDB();

const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');

exportBtn.addEventListener('click', exportAllData);
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', handleImportFile);

async function exportAllData() {
  // 1) paths レコード
  const tx1 = db.transaction([STORE_NAME], 'readonly');
  const store1 = tx1.objectStore(STORE_NAME);
  const pathsRec = await new Promise(resolve => {
    const req = store1.get(PATHS_RECORD_ID);
    req.onsuccess = () => resolve(req.result || { id: PATHS_RECORD_ID, paths: [] });
  });

  // 2) snapshot レコード（prefix が snapshot- の全件）
  const tx2 = db.transaction([STORE_NAME], 'readonly');
  const store2 = tx2.objectStore(STORE_NAME);
  const allRecs = await new Promise(resolve => {
    const req = store2.getAll();
    req.onsuccess = () => resolve(req.result);
  });
  const snaps = allRecs.filter(r => r.id.startsWith('snapshot-'));

  // 3) JSON 化
  const exportObj = {
    paths: pathsRec.paths,
    snapshots: snaps.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      activeIndexes: r.activeIds,
      preview: r.preview
    }))
  };
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // 4) ダウンロード用リンクを自動クリック
  const a = document.createElement('a');
  a.href = url;
  a.download = `sketch-data-${new Date().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);

      // ① 単一のトランザクションで store を開き、全レコードをクリア
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // clear() はリクエストなので、完了を待つ
      await new Promise(resolve => {
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve();
      });

      // ② paths レコードを完全上書き
      store.put({
        id: PATHS_RECORD_ID,
        paths: imported.paths || []
      });

      // ③ snapshots レコードを完全上書き（既存はクリア済み）
      (imported.snapshots || []).forEach(snap => {
        const ids = Array.isArray(snap.activeIds)
     ? snap.activeIds
     : Array.isArray(snap.activeIndexes)
       ? snap.activeIndexes
       : [];
   store.put({
     id:        snap.id,
     timestamp: snap.timestamp,
     activeIds: ids,           // ← 必ず activeIds に統一して保存
     preview:   snap.preview
        });
      });

      // ④ トランザクション完了を待って UI を更新
      await tx.complete;
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

function generateStrokeId() {
  // Date.now()＋ランダム文字列でほぼ衝突しない ID
  return 'stroke-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}




penBtn.addEventListener('click', () => {
  lassoMode = false;
  selectedStrokes.clear();
  redraw();
  updateStrokeList();
});


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

window.addEventListener('keydown', e => {
  if (e.key === 'Alt') {
    altPressed = true;
    redraw();
    updateStrokeList();
  }
});
window.addEventListener('keyup', e => {
  if (e.key === 'Alt') {
    altPressed = false;
    redraw();
    updateStrokeList();
  }
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
    const length   = calcLength(currentPath);
    const duration = endTime - startTime;
    const speed    = length / duration;
    // ← ここで ID を生成してオブジェクトに含める
    const stroke = {
      id:        generateStrokeId(),
      points:    currentPath,
      size:      penSize,
      color:     penColor,
      startTime, endTime,
      duration,  length,
      speed,
      active:    true
    };
    paths.push(stroke);
    redoStack = [];
    updateStrokeList();
    saveAllPathsToDB();
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
    // ALT 押下時は非アクティブも対象に、そうでなければ active=true のみ
    if (!path.active && !altPressed) return;

    for (const pt of path.points) {
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

  paths.forEach((path, i) => {
    // 通常時は active=true のものだけ描く。ALT押下中は全ストローク描画。
    if (!path.active && !altPressed) return;

    // アクティブ／非アクティブで透明度を変える
    ctx.globalAlpha = path.active ? 1.0 : 0.3;

    // 選択中は破線、それ以外は実線
    if (selectedStrokes.has(i)) {
      ctx.setLineDash([6, 4]);
    } else {
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = path.color;
    ctx.lineWidth   = path.size;
    ctx.lineCap     = 'round';

    const pts = path.points;
    for (let j = 1; j < pts.length; j++) {
      ctx.beginPath();
      ctx.moveTo(pts[j - 1].x, pts[j - 1].y);
      ctx.lineTo(pts[j].x,     pts[j].y);
      ctx.stroke();
    }
  });

  // 投げ縄枠は常に表示
  if (lassoMode && lassoStart && lassoEnd) {
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = 'rgba(0,0,255,0.5)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(
      Math.min(lassoStart.x, lassoEnd.x),
      Math.min(lassoStart.y, lassoEnd.y),
      Math.abs(lassoEnd.x - lassoStart.x),
      Math.abs(lassoEnd.y - lassoStart.y)
    );
  }

  // 描画設定リセット
  ctx.globalAlpha = 1.0;
  ctx.setLineDash([]);
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

    // startTime を日付文字列に変換
    const ts = new Date(path.startTime).toLocaleString();

    // info 部分をタイムスタンプに置き換え
    const info = document.createElement('div');
    info.innerHTML = `
      ${ts} — ${path.duration}ms, ${path.length.toFixed(1)}px, ${path.speed.toFixed(2)}px/ms
      <label>
        <input type="checkbox" ${path.active ? 'checked' : ''} onchange="toggleActive(${i})">
        Active
      </label>
    `;

    // プレビュー用キャンバス
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


function loadAllPathsFromDB() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(PATHS_RECORD_ID);
  req.onsuccess = () => {
    if (req.result) {
      paths = req.result.paths.map(p => ({ ...p }));
      updateStrokeList();
      redraw();
    }
  };
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
  // インデックスではなく、active なストロークの ID 一覧を保存
const activeIds = paths
  .filter(p => p.active)
  .map(p => p.id);

  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({ 
    id, timestamp: new Date().toISOString(), activeIds, preview 
  });

  // paths も最新状態を保存
  saveAllPathsToDB();
  alert('スナップショットが保存されました！');
  listSnapshots();
}

function loadSnapshotById(snapshotId) {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(snapshotId);

  req.onsuccess = () => {
    const snap = req.result;
    if (!snap || !Array.isArray(snap.activeIds)) return;
    // まず全ストローク非アクティブ化
    paths.forEach(p => p.active = false);
    // ID が一致するものだけアクティブに
    snap.activeIds.forEach(id => {
      const p = paths.find(path => path.id === id);
      if (p) p.active = true;
    });
    updateStrokeList();
    redraw();
  };
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

    const snaps = request.result.filter(r => r.id.startsWith('snapshot-'));
    snaps.forEach(snapshot => {
      const div = document.createElement('div');
      div.style.marginBottom = '10px';

      const label = document.createElement('div');
      label.textContent = `${snapshot.id} - ${new Date(snapshot.timestamp).toLocaleString()}`;

      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.width = 160;
      img.height = 120;
      img.style.border = '1px solid #ccc';

      img.addEventListener('click', () => loadSnapshotById(snapshot.id));

      div.appendChild(label);
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
    const latest = snaps.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    )[0];
    loadSnapshotById(latest.id);
  };
}


saveBtn.addEventListener('click', () => {
  saveSnapshot();
});

document.getElementById('toggleSelectedBtn').addEventListener('click', () => {
  selectedStrokes.forEach(index => {
    paths[index].active = !paths[index].active;
  });
  updateStrokeList();
});


window.toggleActive = toggleActive;